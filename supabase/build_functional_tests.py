from pathlib import Path
import re

BASE_DIR = Path(__file__).resolve().parent

MIGRATION_FILE = BASE_DIR / "hitpay_combined_validation.sql"

TEST_FILES = [
    "hitpay_functional_tests.sql",
    "hitpay_security_tests.sql",
    "hitpay_member_records_tests.sql",
    "hitpay_member_compatibility_tests.sql",
    "hitpay_admin_authorization_tests.sql",
    "hitpay_admin_compatibility_tests.sql",
]

OUTPUT_FILE = BASE_DIR / "hitpay_combined_functional_tests.sql"

BOUNDARY_PATTERN = re.compile(
    r"^[ \t]*(BEGIN|COMMIT|ROLLBACK)[ \t]*;[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)

CONSTRAINT_PATTERN = re.compile(
    r"^[ \t]*SET[ \t]+CONSTRAINTS[ \t]+ALL"
    r"[ \t]+IMMEDIATE[ \t]*;[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)


def read_sql(path):

    if not path.is_file():
        raise FileNotFoundError(
            f"Required file not found: {path.name}"
        )

    content = path.read_text(
        encoding="utf-8"
    ).strip()

    if not content:
        raise ValueError(
            f"SQL file is empty: {path.name}"
        )

    return content


def comments_or_whitespace_only(content):

    for line in content.splitlines():

        stripped = line.strip()

        if stripped and not stripped.startswith("--"):
            return False

    return True


def main():

    print("=" * 60)
    print("GameChanger HitPay Functional Test Builder")
    print("=" * 60)

    # Read the existing combined migration.

    migration_sql = read_sql(MIGRATION_FILE)

    boundary_matches = list(
        BOUNDARY_PATTERN.finditer(migration_sql)
    )

    boundaries = [
        match.group(1).upper()
        for match in boundary_matches
    ]

    if boundaries != ["BEGIN", "ROLLBACK"]:
        raise ValueError(
            "Migration must contain exactly one BEGIN "
            "and one ROLLBACK."
        )

    begin_match = boundary_matches[0]
    rollback_match = boundary_matches[1]

    if not comments_or_whitespace_only(
        migration_sql[:begin_match.start()]
    ):
        raise ValueError(
            "Unexpected SQL before BEGIN."
        )

    if not comments_or_whitespace_only(
        migration_sql[rollback_match.end():]
    ):
        raise ValueError(
            "Unexpected SQL after ROLLBACK."
        )

    print(f"[OK] {MIGRATION_FILE.name}")

    # Locate the final constraint validation statement.

    constraint_matches = list(
        CONSTRAINT_PATTERN.finditer(migration_sql)
    )

    if not constraint_matches:
        raise ValueError(
            "SET CONSTRAINTS ALL IMMEDIATE was not found."
        )

    constraint_match = constraint_matches[-1]

    if not (
        begin_match.end()
        <= constraint_match.start()
        < rollback_match.start()
    ):
        raise ValueError(
            "Invalid constraint validation position."
        )

    # Allow comments and blank lines between
    # SET CONSTRAINTS and ROLLBACK.

    ending_content = migration_sql[
        constraint_match.end():
        rollback_match.start()
    ]

    if not comments_or_whitespace_only(
        ending_content
    ):
        raise ValueError(
            "Unexpected SQL between constraint "
            "validation and ROLLBACK."
        )

    print("[OK] Final migration statements located")

    # Remove only the verified migration ending.

    migration_body = migration_sql[
        :constraint_match.start()
    ].rstrip()

    sections = [
        "-- GameChanger UC-PAM-01",
        "-- Combined functional database tests",
        "-- Synthetic sandbox records only",
        "-- Shared database: approved testing window only",
        "-- WARNING: Never replace ROLLBACK with COMMIT.",
        "",
        migration_body,
    ]

    # Append all functional test files.

    for filename in TEST_FILES:

        test_path = BASE_DIR / filename

        test_sql = read_sql(test_path)

        if BOUNDARY_PATTERN.search(test_sql):
            raise ValueError(
                f"Unexpected transaction boundary: {filename}"
            )

        sections.extend([
            "",
            "-- " + "=" * 60,
            f"-- TEST FILE: {filename}",
            "-- " + "=" * 60,
            "",
            test_sql,
        ])

        print(f"[OK] {filename}")

    # Restore final constraint validation and rollback.

    sections.extend([
        "",
        "-- Validate deferred database constraints.",
        "SET CONSTRAINTS ALL IMMEDIATE;",
        "",
        "-- Revert all transactional test changes.",
        "ROLLBACK;",
        "",
    ])

    combined_sql = "\n".join(sections)

    # Final transaction boundary verification.

    final_boundaries = [
        match.group(1).upper()
        for match in BOUNDARY_PATTERN.finditer(
            combined_sql
        )
    ]

    if final_boundaries != ["BEGIN", "ROLLBACK"]:
        raise ValueError(
            "Final transaction boundary validation failed."
        )

    if not combined_sql.strip().endswith("ROLLBACK;"):
        raise ValueError(
            "Final SQL statement must be ROLLBACK."
        )

    # Generate output only after all checks pass.

    OUTPUT_FILE.write_text(
        combined_sql,
        encoding="utf-8"
    )

    print()
    print("=" * 60)
    print("FUNCTIONAL TEST SCRIPT GENERATED")
    print("=" * 60)
    print("Transaction boundary checks: PASSED")
    print(f"Functional test files included: {len(TEST_FILES)}")
    print("Database execution: NOT PERFORMED")
    print(f"Total lines: {len(combined_sql.splitlines())}")
    print(f"Output: {OUTPUT_FILE}")
    print("=" * 60)


if __name__ == "__main__":
    main()