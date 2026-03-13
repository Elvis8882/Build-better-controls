#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"
ROUTINES_DIR = ROOT / "supabase" / "routines"

CREATE_FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-zA-Z0-9_]+)\s*\([^)]*\)"
    r"(?P<after_sig>.*?)\bas\s+(?P<quote>\$[A-Za-z0-9_]*\$)",
    re.IGNORECASE | re.DOTALL,
)


def extract_latest_migration_bodies() -> dict[str, tuple[Path, str]]:
    latest: dict[str, tuple[Path, str]] = {}
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))

    for migration_path in migration_files:
        text = migration_path.read_text(encoding="utf-8")
        idx = 0
        while True:
            match = CREATE_FUNCTION_RE.search(text, idx)
            if not match:
                break

            func_name = match.group("name")
            quote = match.group("quote")
            body_start = match.end("quote")
            body_end = text.find(quote, body_start)
            if body_end == -1:
                raise RuntimeError(
                    f"Could not find closing function delimiter {quote!r} for {func_name} in {migration_path}"
                )

            body = text[body_start:body_end]
            latest[func_name] = (migration_path, body)
            idx = body_end + len(quote)

    return latest


def main() -> int:
    latest = extract_latest_migration_bodies()

    missing_defs: list[str] = []
    drifted: list[tuple[str, Path]] = []

    for routine_path in sorted(ROUTINES_DIR.glob("*.sql")):
        function_name = routine_path.stem
        routine_body = routine_path.read_text(encoding="utf-8")

        latest_entry = latest.get(function_name)
        if latest_entry is None:
            missing_defs.append(function_name)
            continue

        migration_path, migration_body = latest_entry

        normalized_routine = routine_body.strip()
        normalized_migration = migration_body.strip()

        if normalized_routine != normalized_migration:
            drifted.append((function_name, migration_path))

    if missing_defs or drifted:
        print("Supabase routine drift detected:")
        for function_name in missing_defs:
            print(f" - {function_name}: no CREATE OR REPLACE FUNCTION found in migrations")
        for function_name, migration_path in drifted:
            print(
                f" - {function_name}: routine body differs from latest migration definition ({migration_path.relative_to(ROOT)})"
            )
        return 1

    print("Supabase routines are in sync with latest migration function bodies.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
