from sqlalchemy import text
from app.database import engine

statements = [
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS report_id VARCHAR(60)",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS work_order_id VARCHAR(60)",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS equipment_id VARCHAR(50)",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS work_summary TEXT",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS finding TEXT",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS action_taken TEXT",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS equipment_status VARCHAR(50)",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS labor_hours FLOAT",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP",
    "ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS approved_by VARCHAR(150)",
    "ALTER TABLE daily_report_items ADD COLUMN IF NOT EXISTS component_id VARCHAR(60)",
    "ALTER TABLE daily_report_items ADD COLUMN IF NOT EXISTS maintenance_type VARCHAR(40)",
    "ALTER TABLE daily_report_items ADD COLUMN IF NOT EXISTS action_taken TEXT",
    "ALTER TABLE daily_report_items ADD COLUMN IF NOT EXISTS pm_id VARCHAR(60)",
    "ALTER TABLE daily_report_items ADD COLUMN IF NOT EXISTS wo_id VARCHAR(60)",
]

with engine.begin() as conn:
    for statement in statements:
        conn.execute(text(statement))

    conn.execute(text("""
        UPDATE daily_reports
        SET report_id =
            'DR-' ||
            to_char(report_date, 'YYYYMMDD') ||
            '-' ||
            lpad(id::text, 5, '0')
        WHERE report_id IS NULL
    """))

    conn.execute(text("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'daily_report_items'
                  AND column_name = 'daily_report_id'
            )
            AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'daily_report_items'
                  AND column_name = 'report_id'
            )
            THEN
                ALTER TABLE daily_report_items
                RENAME COLUMN daily_report_id TO report_id;
            END IF;
        END
        $$;
    """))

    conn.execute(text("""
        ALTER TABLE daily_reports
        ALTER COLUMN report_id SET NOT NULL
    """))

    conn.execute(text("""
        CREATE UNIQUE INDEX IF NOT EXISTS
        ix_daily_reports_report_id
        ON daily_reports(report_id)
    """))

print("Daily Report migration completed successfully.")
