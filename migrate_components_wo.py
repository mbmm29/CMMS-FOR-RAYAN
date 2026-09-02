from sqlalchemy import text
from app.database import engine

with engine.begin() as conn:
    # Components
    conn.execute(text("""
        ALTER TABLE components
        ADD COLUMN IF NOT EXISTS installation_date DATE
    """))

    conn.execute(text("""
        ALTER TABLE components
        ADD COLUMN IF NOT EXISTS removal_date DATE
    """))

    # Work Orders
    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS request_date DATE
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS planned_date DATE
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS assigned_technician_id VARCHAR(60)
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS verification TEXT
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS parts_used TEXT
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS closed_by VARCHAR(150)
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS closing_date TIMESTAMP
    """))

    conn.execute(text("""
        ALTER TABLE work_orders
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(150)
    """))

    conn.execute(text("""
        UPDATE work_orders
        SET request_date = CURRENT_DATE
        WHERE request_date IS NULL
    """))

print("Components and Work Orders migration completed successfully.")
