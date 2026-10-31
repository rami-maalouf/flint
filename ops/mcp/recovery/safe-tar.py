#!/usr/bin/env python3
import re
import sys
import tarfile


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[3] not in ('data', 'keys'):
        raise SystemExit('tar validation requires archive, destination and kind')
    archive_path, destination, kind = sys.argv[1:]
    seen = set()
    total = 0
    links = []
    regular = set()
    with tarfile.open(archive_path, 'r:') as archive:
        members = archive.getmembers()
        if len(members) > 100_000:
            raise SystemExit('archive entry bound exceeded')
        for member in members:
            name = member.name.removeprefix('./')
            if not name or name == '.':
                continue
            if (name.startswith('/') or '..' in name.split('/') or name in seen or
                    any(part in ('', '.') for part in name.split('/')) or
                    not (member.isfile() or member.isdir() or member.issym())):
                raise SystemExit('unsafe archive member')
            if member.issym():
                if (kind != 'data' or
                        not re.fullmatch(r'backend/releases/[1-9][0-9]*/\.snapback4/store\.sqlite', name) or
                        len(name) > 168 or member.linkname != '../../../store.sqlite'):
                    raise SystemExit('unsafe archive link')
                links.append(name)
            elif member.isfile():
                regular.add(name)
            elif member.mode & 0o002:
                raise SystemExit('world writable archive directory')
            native_release_dir = (name == 'backend/releases' or
                                  (len(name) <= 168 and re.fullmatch(
                                      r'backend/releases/[1-9][0-9]*(?:/snapback)?', name)))
            if member.isdir() and (member.mode & 0o020) and not (kind == 'data' and native_release_dir):
                raise SystemExit('group writable archive directory')
            if member.isdir() and name == 'backend' and (member.mode & 0o777) != 0o700:
                raise SystemExit('backend root must be private')
            seen.add(name)
            total += member.size
            if member.size > 512 * 1024 ** 2 or total > 4 * 1024 ** 3:
                raise SystemExit('archive size bound exceeded')
            tarfile.data_filter(member, destination)
        if links and ('backend' not in seen or 'backend/store.sqlite' not in regular):
            raise SystemExit('missing regular backend store')
        for link in links:
            if any(name.startswith(link + '/') for name in seen):
                raise SystemExit('archive entry beneath link')
        archive.extractall(destination, filter='data')


if __name__ == '__main__':
    main()
