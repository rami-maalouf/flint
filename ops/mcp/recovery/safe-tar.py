#!/usr/bin/env python3
import os
import sys
import tarfile


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit('tar validation requires archive and destination')
    archive_path, destination = sys.argv[1:]
    seen = set()
    total = 0
    with tarfile.open(archive_path, 'r:') as archive:
        members = archive.getmembers()
        if len(members) > 100_000:
            raise SystemExit('archive entry bound exceeded')
        for member in members:
            name = member.name.removeprefix('./')
            if not name or name == '.':
                continue
            if (name.startswith('/') or '..' in name.split('/') or name in seen or
                    not (member.isfile() or member.isdir())):
                raise SystemExit('unsafe archive member')
            seen.add(name)
            total += member.size
            if member.size > 512 * 1024 ** 2 or total > 4 * 1024 ** 3:
                raise SystemExit('archive size bound exceeded')
            tarfile.data_filter(member, destination)
        archive.extractall(destination, filter='data')


if __name__ == '__main__':
    main()
