from sqlalchemy import text
from app.database import engine

with engine.begin() as conn:
    conn.execute(text("""
        ALTER TABLE equipment
        ADD COLUMN IF NOT EXISTS plant_id VARCHAR(60)
    """))

print("Equipment migration completed successfully.")
