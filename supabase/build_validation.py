
from pathlib import Path
import re

BASE_DIR = Path(__file__).resolve().parent


# Migration execution order.
SQL_FILES = [
    "hitpay_payment.sql",
    "hitpay_functions.sql",
    "hitpay_sandbox_protection.sql",
    "hitpay_finalize.sql",
    "hitpay_checkout_protection.sql",
    "hitpay_transactions.sql",
    "hitpay_security.sql",
    "hitpay_hardening.sql",
    "hitpay_legacy_protection.sql",
    "hitpay_write_protection.sql",
    "hitpay_session_protection.sql",
    "hitpay_permission_protection.sql",
    "hitpay_revenue_protection.sql",
    "hitpay_member_records.sql",
    "hitpay_admin_records.sql",
    "hitpay_join_protection.sql",
    "hitpay_audit_records.sql",
]


OUTPUT_FILE = BASE_DIR / "hitpay_combined_validation.sql"


TRANSACTION_PATTERN = re.compile(
    r"^[ \t]*(BEGIN|COMMIT|ROLLBACK)[ \t]*;[ \t]*$",
    re.IGNORECASE,
)


# Validate migration list.
if len(SQL_FILES) != 17:
    raise ValueError(
        "Expected exactly 17 migration files."
    )


if len(SQL_FILES) != len(set(SQL_FILES)):
    raise ValueError(
        "Duplicate migration files detected."
    )


# Confirm all required files exist.
missing_files = [
    filename
    for filename in SQL_FILES
    if not (BASE_DIR / filename).is_file()
]


if missing_files:
    raise FileNotFoundError(
        "Missing SQL files:\n"
        + "\n".join(missing_files)
    )


combined = [
    "-- GameChanger: UC-PAM-01 Process Payment",
    "-- HitPay Sandbox Combined Migration Validation",
    f"-- Total migrations: {len(SQL_FILES)}",
    "-- Validation only. Do not replace ROLLBACK with COMMIT.",
    "-- Execute only in an isolated validation database.",
    "",
    "BEGIN;",
    "",
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '60s';",
    "",
]


print("Validating HitPay migration files...")
print()


for index, filename in enumerate(SQL_FILES, start=1):

    path = BASE_DIR / filename

    content = path.read_text(
        encoding="utf-8-sig"
    )

    lines = content.splitlines()


    # Locate transaction boundaries.
    boundaries = []

    for line_index, line in enumerate(lines):

        match = TRANSACTION_PATTERN.fullmatch(line)

        if match:

            boundaries.append(
                (
                    line_index,
                    match.group(1).upper()
                )
            )


    # Require exactly one BEGIN and one COMMIT.
    if len(boundaries) != 2:

        raise ValueError(
            f"Unexpected transaction boundaries in {filename}"
        )


    begin_index, begin_command = boundaries[0]

    commit_index, commit_command = boundaries[1]


    if begin_command != "BEGIN":

        raise ValueError(
            f"Missing opening BEGIN in {filename}"
        )


    if commit_command != "COMMIT":

        raise ValueError(
            f"Missing closing COMMIT in {filename}"
        )


    # Allow only comments and blank lines
    # outside the original transaction.
    outside_lines = (
        lines[:begin_index]
        + lines[commit_index + 1:]
    )


    for line in outside_lines:

        stripped = line.strip()

        if stripped and not stripped.startswith("--"):

            raise ValueError(
                f"Unexpected SQL outside transaction in {filename}"
            )


    # Remove only the original transaction boundaries.
    # Preserve comments and migration statements.
    cleaned_lines = [
        line
        for line_index, line in enumerate(lines)
        if line_index not in (
            begin_index,
            commit_index
        )
    ]


    cleaned_content = "\n".join(
        cleaned_lines
    ).strip()


    if not cleaned_content:

        raise ValueError(
            f"Empty migration content: {filename}"
        )


    combined.extend([
        "-- =========================================",
        f"-- Migration {index:02d}: {filename}",
        "-- =========================================",
        "",
        cleaned_content,
        "",
    ])


    print(
        f"[OK] {index:02d}. {filename}"
    )


# Force deferred constraints to be checked
# before rolling back.
combined.extend([
    "-- Validate deferred database constraints.",
    "SET CONSTRAINTS ALL IMMEDIATE;",
    "",
    "-- End of migration validation.",
    "ROLLBACK;",
    "",
])


# Verify the final combined transaction boundaries.
final_boundaries = [
    TRANSACTION_PATTERN.fullmatch(line).group(1).upper()

    for line in combined

    for line in line.splitlines()

    if TRANSACTION_PATTERN.fullmatch(line)
]


if final_boundaries != ["BEGIN", "ROLLBACK"]:

    raise ValueError(
        "Combined script contains unsafe transaction boundaries."
    )


# Generate the combined validation SQL.
OUTPUT_FILE.write_text(
    "\n".join(combined),
    encoding="utf-8",
)


print()
print("=========================================")
print("Combined validation script generated.")
print("=========================================")
print(f"Output: {OUTPUT_FILE}")
print(f"Total migrations: {len(SQL_FILES)}")
print("Migration list checks: PASSED")
print("Transaction mode: ROLLBACK")
print("Transaction boundary checks: PASSED")
print("Database execution: NOT PERFORMED")
print("=========================================")
