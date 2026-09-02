from sqlalchemy import text
from app.database import engine

with engine.begin() as conn:
    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS component_id VARCHAR(60)
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS pm_type VARCHAR(40)
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS frequency VARCHAR(40)
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS frequency_value INTEGER
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS last_pm_date DATE
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS next_due_date DATE
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS estimated_time_h FLOAT
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS priority VARCHAR(30)
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS sop_id VARCHAR(60)
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS added_unplanned BOOLEAN DEFAULT FALSE
    """))

    conn.execute(text("""
        ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS added_reason TEXT
    """))

print("PM migration completed successfully.")
