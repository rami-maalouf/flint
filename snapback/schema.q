use identity password

table profiles:
  owner: principal
  name: text <=120 default ''
  revision: int 0.. default 0
  unique owner
  immutable owner
  read <- .owner = viewer
  insert <- .owner = viewer
  update <- .owner = viewer
  online only

query profile():
  return profiles[viewer]

mutation saveProfile(name: text <=120):
  return upsert profiles[viewer] { owner: viewer, name }

invariant profiles.read only .owner = viewer

table records:
  owner: principal
  entityType: enum('board', 'activity_period', 'check_in', 'reminder', 'settings', 'reward', 'habit_action', 'ledger_entry')
  entityId: text 1..255
  variant: text <=64
  schemaVersion: int 1..2
  mutationStamp: text 1..255
  deleted: bool
  payload: text <=8192
  body: uploads ?
  digest: text 64..64
  revision: int 1..
  unique owner, entityType, entityId, variant
  immutable owner, entityType, entityId, variant
  read <- .owner = viewer
  insert <- .owner = viewer
  update <- .owner = viewer and .entityType != 'habit_action' and .entityType != 'ledger_entry'
  sync to .owner

mutation ensureAccount():
  if exists profiles[viewer]:
    return profiles[viewer]
  return insert profiles { owner: viewer }

query changes(after: int 0..):
  return records where .owner = viewer and .revision > after first 200 by .revision

query recordsByType(entityType: enum('board', 'activity_period', 'check_in', 'reminder', 'settings', 'reward', 'habit_action', 'ledger_entry'), c: cursor ?):
  return records where .owner = viewer and .entityType = entityType first 50 by .entityId after c

mutation uploadRecord(entityType: enum('board', 'activity_period', 'check_in', 'reminder', 'settings', 'reward', 'habit_action', 'ledger_entry'), entityId: text 1..255, schemaVersion: int 1..2, mutationStamp: text 22..255, deleted: bool, payload: text <=8192, body: uploads ?, digest: text 64..64): server
  account = profiles[viewer] ! else ACCOUNT_REQUIRED
  require allDigits(slice(mutationStamp, 0, 14)) and slice(mutationStamp, 14, 15) = '-' and slice(mutationStamp, 20, 21) = '-' else INVALID_STAMP
  for i in range(15, 20):
    c = slice(mutationStamp, i, i + 1)
    require (c >= '0' and c <= '9') or (c >= 'a' and c <= 'z') else INVALID_STAMP
  for i in range(21, count(mutationStamp)):
    c = slice(mutationStamp, i, i + 1)
    require (c >= '0' and c <= '9') or (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c = '_' or c = '-' else INVALID_STAMP
  fact = entityType = 'habit_action' or entityType = 'ledger_entry'
  require not fact or (schemaVersion = 2 and not deleted) else INVALID_FACT
  if body != null:
    upload = uploads[body] ! else INVALID_PAYLOAD
    require upload.owner = viewer and upload.verified and upload.key = digest and payload = '' else INVALID_PAYLOAD
  else:
    require sha256(payload) = digest else INVALID_PAYLOAD
  variant = digest if fact else ''
  existing = records[viewer, entityType, entityId, variant]
  if existing != null:
    if fact or mutationStamp < existing.mutationStamp:
      return existing
    if mutationStamp = existing.mutationStamp:
      require digest = existing.digest and deleted = existing.deleted and schemaVersion = existing.schemaVersion else STAMP_CONFLICT
      return existing
  revision = account.revision + 1
  update profiles[viewer] { revision }
  return upsert records[viewer, entityType, entityId, variant] { owner: viewer, entityType, entityId, variant, schemaVersion, mutationStamp, deleted, payload, body, digest, revision }

invariant records.read only .owner = viewer

table uploads:
  owner: principal
  key: text 64..64
  partCount: int 2..640
  verified: bool default false
  createdAt: time default now
  unique owner, key
  immutable owner, key, partCount, createdAt
  read <- .owner = viewer
  insert <- .owner = viewer
  update (old, next) <- old.owner = viewer and next.owner = viewer and not old.verified
  online only

table parts:
  upload: uploads
  position: int 0..639
  payload: text <=8192
  digest: text 64..64
  unique upload, position
  immutable upload, position, payload, digest
  cap 640 by upload
  read <- exists uploads[id = .upload, owner = viewer]
  insert <- exists uploads[id = .upload, owner = viewer, verified = false]
  online only

mutation beginUpload(key: text 64..64, partCount: int 2..640):
  existing = uploads[viewer, key]
  if existing != null:
    require existing.partCount = partCount else UPLOAD_CONFLICT
    return existing
  return insert uploads { owner: viewer, key, partCount }

mutation uploadPart(upload: uploads, position: int 0..639, payload: text <=8192):
  parent = uploads[upload] ! else NOT_FOUND
  require parent.owner = viewer and position < parent.partCount else NOT_FOUND
  require (position = parent.partCount - 1 and count(payload) > 0) or (position < parent.partCount - 1 and count(payload) = 8192) else NON_CANONICAL_PART
  existing = parts[upload, position]
  digest = sha256(payload)
  if existing != null:
    require digest = existing.digest else PART_CONFLICT
    return { id: existing.id, digest }
  part = insert parts { upload, position, payload, digest }
  return { id: part.id, digest }

mutation finishUpload(upload: uploads): server
  parent = uploads[upload] ! else NOT_FOUND
  require parent.owner = viewer else NOT_FOUND
  if parent.verified:
    return parent
  digest = ''
  position = 0
  for part in parts where .upload = upload first 640 by .position { position, digest }:
    require part.position = position else INCOMPLETE_UPLOAD
    digest = sha256(digest + part.digest)
    position = position + 1
  require position = parent.partCount and digest = parent.key else INVALID_PAYLOAD
  return update uploads[upload] { verified: true }

query bodyParts(upload: uploads, after: int 0..640):
  return parts where .upload = upload and .position >= after first 16 by .position

invariant uploads.read only .owner = viewer
