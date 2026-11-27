
"""
GameChanger UC-PAM-01
Additional functional database test builder

Combines:
    1. Existing combined migration validation
    2. Alternative payment tests (FT-14 to FT-18)
    3. Reconciliation and security tests (FT-19 to FT-22)

Produces:
    hitpay_combined_additional_tests.sql

This script does not connect to or modify the database.
"""

from pathlib import Path
import re
import sys


# ============================================================
# File configuration
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

MIGRATION_FILE = BASE_DIR / "hitpay_combined_validation.sql"

TEST_FILES = [
    BASE_DIR / "hitpay_alternative_tests.sql",
    BASE_DIR / "hitpay_reconciliation_tests.sql",
]

OUTPUT_FILE = BASE_DIR / "hitpay_combined_additional_tests.sql"


# ============================================================
# Validation patterns
# ============================================================

TRANSACTION_PATTERN = re.compile(
    r"^[ \t]*(BEGIN|COMMIT|ROLLBACK)[ \t]*;[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

CONSTRAINT_PATTERN = re.compile(
    r"^[ \t]*SET[ \t]+CONSTRAINTS[ \t]+ALL"
    r"[ \t]+IMMEDIATE[ \t]*;[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

TEST_BOUNDARIES = {
    "hitpay_alternative_tests.sql": "$alternative_tests$",
    "hitpay_reconciliation_tests.sql": "$reconciliation_tests$",
}


# ============================================================
# Helper functions
# ============================================================

def fail(message):
    raise ValueError(message)


def read_required_file(path):

    if not path.is_file():
        fail(f"Required file not found: {path.name}")

    content = path.read_text(encoding="utf-8-sig")

    if not content.strip():
        fail(f"Required file is empty: {path.name}")

    print(f"[OK] {path.name}")

    return content


def comments_or_whitespace_only(content):

    for line in content.splitlines():

        stripped = line.strip()

        if stripped and not stripped.startswith("--"):
            return False

    return True


def get_transaction_boundaries(content):

    return list(
        TRANSACTION_PATTERN.finditer(content)
    )


# ============================================================
# Validate the existing combined migration
# ============================================================

def prepare_migration(content):

    boundaries = get_transaction_boundaries(content)

    if len(boundaries) != 2:

        fail(
            "Migration must contain exactly two "
            "standalone transaction boundaries."
        )

    begin_match = boundaries[0]

    rollback_match = boundaries[1]

    if begin_match.group(1).upper() != "BEGIN":
        fail("Migration must begin with BEGIN;")

    if rollback_match.group(1).upper() != "ROLLBACK":
        fail("Migration must end with ROLLBACK;")

    if not comments_or_whitespace_only(
        content[:begin_match.start()]
    ):

        fail("Unexpected content before BEGIN;")

    if not comments_or_whitespace_only(
        content[rollback_match.end():]
    ):

        fail("Unexpected content after ROLLBACK;")

    constraint_matches = list(
        CONSTRAINT_PATTERN.finditer(content)
    )

    if len(constraint_matches) != 1:

        fail(
            "Expected exactly one final "
            "SET CONSTRAINTS ALL IMMEDIATE statement."
        )

    constraint_match = constraint_matches[0]

    if not (
        begin_match.end()
        < constraint_match.start()
        < rollback_match.start()
    ):

        fail("Invalid final constraint statement position.")

    between_final_statements = content[
        constraint_match.end():rollback_match.start()
    ]

    if not comments_or_whitespace_only(
        between_final_statements
    ):

        fail(
            "Unexpected SQL between final constraint "
            "validation and ROLLBACK."
        )

    # Retain the migration and its original BEGIN.
    # Remove the final constraint check and ROLLBACK
    # so the additional tests can execute first.

    migration_body = content[
        :constraint_match.start()
    ].rstrip()

    print("[OK] Migration transaction boundaries verified")

    print("[OK] Final migration statements located")

    return migration_body


# ============================================================
# Validate individual additional test files
# ============================================================

def prepare_test_file(path):

    content = read_required_file(path)

    boundaries = get_transaction_boundaries(content)

    if boundaries:

        fail(
            f"{path.name} contains a standalone "
            "transaction statement."
        )

    expected_tag = TEST_BOUNDARIES[path.name]

    opening_pattern = re.compile(
        r"^[ \t]*DO[ \t]+"
        + re.escape(expected_tag)
        + r"[ \t]*$",
        re.MULTILINE | re.IGNORECASE,
    )

    closing_pattern = re.compile(
        r"^[ \t]*"
        + re.escape(expected_tag)
        + r";[ \t]*$",
        re.MULTILINE,
    )

    opening_matches = list(
        opening_pattern.finditer(content)
    )

    closing_matches = list(
        closing_pattern.finditer(content)
    )

    if len(opening_matches) != 1:

        fail(
            f"{path.name}: expected exactly one "
            "opening DO block."
        )

    if len(closing_matches) != 1:

        fail(
            f"{path.name}: expected exactly one "
            "closing DO block."
        )

    opening = opening_matches[0]

    closing = closing_matches[0]

    if opening.end() >= closing.start():

        fail(f"{path.name}: invalid DO block order.")

    if not comments_or_whitespace_only(
        content[:opening.start()]
    ):

        fail(
            f"{path.name}: unexpected SQL "
            "before the DO block."
        )

    if not comments_or_whitespace_only(
        content[closing.end():]
    ):

        fail(
            f"{path.name}: unexpected SQL "
            "after the DO block."
        )

    print(f"[OK] {path.name}: DO block verified")

    print(
        f"[OK] {path.name}: "
        "no standalone transaction statements"
    )

    return content.strip()


# ============================================================
# Generate combined additional test script
# ============================================================

def build_additional_tests():

    migration_content = read_required_file(
        MIGRATION_FILE
    )

    migration_body = prepare_migration(
        migration_content
    )

    sections = [

        "-- GameChanger UC-PAM-01",

        "-- Combined additional functional database tests",

        "-- FT-14 to FT-22",

        "-- Synthetic sandbox records only",

        "-- Shared database: approved testing window only",

        "-- WARNING: Never replace ROLLBACK with COMMIT.",

        "",

        migration_body,

        "",
    ]

    for test_file in TEST_FILES:

        test_content = prepare_test_file(test_file)

        sections.extend([

            "",

            "-- " + "=" * 60,

            f"-- TEST FILE: {test_file.name}",

            "-- " + "=" * 60,

            "",

            test_content,

            "",
        ])

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


    # ========================================================
    # Final structural validation
    # ========================================================

    boundaries = get_transaction_boundaries(
        combined_sql
    )

    boundary_names = [

        match.group(1).upper()

        for match in boundaries
    ]

    if boundary_names != ["BEGIN", "ROLLBACK"]:

        fail(
            "Combined script must contain exactly "
            "one BEGIN and one ROLLBACK."
        )

    if not combined_sql.rstrip().endswith(
        "ROLLBACK;"
    ):

        fail("Combined script must end with ROLLBACK;")

    final_constraints = list(
        CONSTRAINT_PATTERN.finditer(combined_sql)
    )

    if len(final_constraints) != 1:

        fail(
            "Combined script must contain exactly "
            "one final constraint validation."
        )

    alternative_marker = (
        "-- TEST FILE: hitpay_alternative_tests.sql"
    )

    reconciliation_marker = (
        "-- TEST FILE: hitpay_reconciliation_tests.sql"
    )

    if combined_sql.count(alternative_marker) != 1:

        fail("Alternative test section missing or duplicated.")

    if combined_sql.count(reconciliation_marker) != 1:

        fail(
            "Reconciliation test section missing "
            "or duplicated."
        )

    alternative_position = combined_sql.index(
        alternative_marker
    )

    reconciliation_position = combined_sql.index(
        reconciliation_marker
    )

    constraint_position = final_constraints[0].start()

    rollback_position = boundaries[-1].start()

    if not (

        boundaries[0].end()

        < alternative_position

        < reconciliation_position

        < constraint_position

        < rollback_position

    ):

        fail("Combined test execution order is incorrect.")


    # Write output only after structural checks pass.

    OUTPUT_FILE.write_text(
        combined_sql,
        encoding="utf-8",
    )

    total_lines = len(
        combined_sql.splitlines()
    )

    print()

    print("=" * 60)

    print("ADDITIONAL FUNCTIONAL TEST SCRIPT GENERATED")

    print("=" * 60)

    print("Transaction boundary checks: PASSED")

    print("Test execution order: PASSED")

    print("Additional test files included: 2")

    print("Database execution: NOT PERFORMED")

    print(f"Total lines: {total_lines}")

    print(f"Output: {OUTPUT_FILE}")

    print("=" * 60)


# ============================================================
# Entry point
# ============================================================

if __name__ == "__main__":

    try:

        build_additional_tests()

    except (ValueError, OSError) as error:

        print(
            f"[ERROR] {error}",
            file=sys.stderr,
        )

        sys.exit(1)
