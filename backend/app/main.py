import os
from datetime import date, datetime, timedelta
import json
import secrets
import threading
import time
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from sqlalchemy import and_, func, or_, inspect, text
from .database import Base, engine, get_db, SessionLocal
from .models import *
from .schemas import *
from .security import *
from .kpi import compute_kpi, save_kpi_target
from .motor_catalog import OIL_CONDITIONS, OIL_LEVELS, motor_catalog_payload, motor_place, motor_sheet_allowed

Base.metadata.create_all(bind=engine)

def ensure_additive_columns():
    """Add missing columns required by the live report workflow.

    This is deliberately additive so existing CMMS records remain intact.
    Proper Alembic migrations should replace it before production deployment.
    """
    inspector = inspect(engine)
    try:
        tables = set(inspector.get_table_names())
        if 'daily_report_items' in tables:
            existing = {c['name'] for c in inspector.get_columns('daily_report_items')}
            additions = {
            'downtime_start': 'TIME',
            'downtime_end': 'TIME',
            'downtime_reason': 'TEXT',
                'equipment_code': 'VARCHAR(50)',
                'equipment_name': 'VARCHAR(150)',
                'plant_id': 'VARCHAR(50)',
                'line_id': 'VARCHAR(50)',
                'is_manual_entry': 'BOOLEAN DEFAULT FALSE',
                'entered_line_number': 'VARCHAR(20)',
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(
                            f'ALTER TABLE daily_report_items ADD COLUMN {name} {sql_type}'
                        ))
        if 'daily_reports' in tables:
            existing = {c['name'] for c in inspector.get_columns('daily_reports')}
            if 'general_notes' not in existing:
                with engine.begin() as conn:
                    conn.execute(text('ALTER TABLE daily_reports ADD COLUMN general_notes TEXT'))
            if 'plant_id' not in existing:
                with engine.begin() as conn:
                    conn.execute(text('ALTER TABLE daily_reports ADD COLUMN plant_id VARCHAR(50)'))
            if 'return_reason' not in existing:
                with engine.begin() as conn:
                    conn.execute(text('ALTER TABLE daily_reports ADD COLUMN return_reason TEXT'))
            if 'returned_at' not in existing:
                with engine.begin() as conn:
                    conn.execute(text('ALTER TABLE daily_reports ADD COLUMN returned_at TIMESTAMP'))
            if 'audit_trail' in tables:
                with engine.begin() as conn:
                    conn.execute(text(
                        "UPDATE daily_reports AS report "
                        "SET returned_at = trail.created_at "
                        "FROM ("
                        "SELECT entity_id, MAX(created_at) AS created_at "
                        "FROM audit_trail "
                        "WHERE action = 'RETURN' AND entity = 'DailyReport' "
                        "GROUP BY entity_id"
                        ") AS trail "
                        "WHERE report.report_id = trail.entity_id "
                        "AND report.status = 'Returned' "
                        "AND report.returned_at IS NULL"
                    ))
        for table in ('work_orders', 'pm_plans'):
            if table not in tables:
                continue
            existing = {c['name']: c for c in inspector.get_columns(table)}
            additions = {
                'manual_equipment_code': 'VARCHAR(50)',
                'manual_equipment_name': 'VARCHAR(150)',
                'manual_plant_id': 'VARCHAR(50)',
                'manual_line_id': 'VARCHAR(50)',
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(
                            f'ALTER TABLE {table} ADD COLUMN {name} {sql_type}'
                        ))
                if 'equipment_id' in existing and not existing['equipment_id']['nullable']:
                    conn.execute(text(
                        f'ALTER TABLE {table} ALTER COLUMN equipment_id DROP NOT NULL'
                    ))
        if 'work_orders' in tables:
            existing = {c['name'] for c in inspector.get_columns('work_orders')}
            if 'records_committed' not in existing:
                with engine.begin() as conn:
                    conn.execute(text('ALTER TABLE work_orders ADD COLUMN records_committed BOOLEAN DEFAULT FALSE'))
            if 'crew_type' not in existing:
                with engine.begin() as conn:
                    conn.execute(text('ALTER TABLE work_orders ADD COLUMN crew_type VARCHAR(30)'))
        if 'work_order_assignments' in tables:
            existing = {c['name'] for c in inspector.get_columns('work_order_assignments')}
            additions = {
                'response': "VARCHAR(20) DEFAULT 'Pending'",
                'assigned_at': 'TIMESTAMP',
                'responded_at': 'TIMESTAMP',
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(f'ALTER TABLE work_order_assignments ADD COLUMN {name} {sql_type}'))
                conn.execute(text("UPDATE work_order_assignments SET response = 'Pending' WHERE response IS NULL"))
                conn.execute(text('UPDATE work_order_assignments SET assigned_at = CURRENT_TIMESTAMP WHERE assigned_at IS NULL'))
        if 'plant_lines' in tables:
            existing = {c['name'] for c in inspector.get_columns('plant_lines')}
            with engine.begin() as conn:
                if 'line_number' not in existing:
                    conn.execute(text('ALTER TABLE plant_lines ADD COLUMN line_number INTEGER'))
                conn.execute(text('''
                    UPDATE plant_lines AS line
                    SET line_number = numbered.line_number
                    FROM (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY plant_id ORDER BY id) AS line_number
                        FROM plant_lines
                        WHERE line_number IS NULL
                    ) AS numbered
                    WHERE line.id = numbered.id
                '''))
                conn.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_plant_line_number ON plant_lines (plant_id, line_number)'))
        if 'annual_pm_items' in tables:
            existing = {c['name'] for c in inspector.get_columns('annual_pm_items')}
            additions = {
                'days': "TEXT DEFAULT ''",
                'maintenance_type': "VARCHAR(40) DEFAULT 'Preventive'",
                'line_key': "VARCHAR(40) DEFAULT ''",
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(f'ALTER TABLE annual_pm_items ADD COLUMN {name} {sql_type}'))
        if 'annual_pm_day_tasks' in tables:
            existing = {c['name'] for c in inspector.get_columns('annual_pm_day_tasks')}
            additions = {
                'maintenance_type': "VARCHAR(40) DEFAULT 'Preventive'",
                'source_key': "VARCHAR(40) DEFAULT ''",
                'technician_id': 'VARCHAR(50)',
                'work_order_id': 'VARCHAR(60)',
                'released_at': 'TIMESTAMP',
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(f'ALTER TABLE annual_pm_day_tasks ADD COLUMN {name} {sql_type}'))
        if 'lubrication_lines' in tables:
            existing = {c['name'] for c in inspector.get_columns('lubrication_lines')}
            additions = {
                'work_type': "VARCHAR(30) DEFAULT ''",
                'work_order_id': 'VARCHAR(60)',
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(f'ALTER TABLE lubrication_lines ADD COLUMN {name} {sql_type}'))
        if 'motor_condition_readings' in tables:
            existing = {c['name']: c for c in inspector.get_columns('motor_condition_readings')}
            additions = {
                'plant': "VARCHAR(80) DEFAULT ''",
                'line_number': "VARCHAR(40) DEFAULT ''",
                'equipment_id': "VARCHAR(50) DEFAULT ''",
            }
            with engine.begin() as conn:
                for name, sql_type in additions.items():
                    if name not in existing:
                        conn.execute(text(f'ALTER TABLE motor_condition_readings ADD COLUMN {name} {sql_type}'))
                machine = existing.get('machine') or {}
                column_type = machine.get('type') if isinstance(machine, dict) else None
                length = getattr(column_type, 'length', None)
                if machine and (length is None or length < 150):
                    conn.execute(text('ALTER TABLE motor_condition_readings ALTER COLUMN machine TYPE VARCHAR(150)'))
    except Exception:
        # Do not prevent the API from starting because of an optional migration.
        # The error will be visible in the application logs.
        pass

ensure_additive_columns()

app=FastAPI(title='Mechanical Maintenance CMMS API',version='2.0.0')

# This API authenticates requests with an Authorization header, not cookies.
# Keep the browser origins explicit so another website cannot use the API.
cors_origins = [
    origin.strip()
    for origin in os.getenv('CORS_ORIGINS', 'http://localhost:3000,http://localhost:4173,http://localhost:8000').split(',')
    if origin.strip()
]
# Windows browsers and local preview tools can use either localhost or
# 127.0.0.1.  They are different web origins, so both must be allowed or the
# browser blocks the request and reports only "Failed to fetch".
for local_origin in (
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:8000',
    'http://localhost:5500',
    'http://[::1]:8000',
    'null',
):
    if local_origin not in cors_origins:
        cors_origins.append(local_origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    # Local preview tools pick a new port each time. Loopback origins stay
    # allowed; any other website is still rejected.
    allow_origin_regex=r'https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?',
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'PUT', 'DELETE'],
    allow_headers=['Authorization', 'Content-Type'],
)

ROLES = {
    'SYSTEM_DEVELOPER',
    'MAINTENANCE_ENGINEER',
    'TECHNICIAN',
    'LUBRICATION_TECHNICIAN',
    'ADMINISTRATOR_VIEWER',
}

ENGINEER = {
    'SYSTEM_DEVELOPER',
    'MAINTENANCE_ENGINEER',
}

DEVELOPER = {
    'SYSTEM_DEVELOPER',
}

TECHNICIAN = {
    'TECHNICIAN',
    'LUBRICATION_TECHNICIAN',
}

def is_technician_account(account) -> bool:
    role = account if isinstance(account, str) else getattr(account, 'role', None)
    return role in TECHNICIAN

VIEWER = {
    'ADMINISTRATOR_VIEWER',
}

MOTOR = ENGINEER | {'LUBRICATION_TECHNICIAN'}
security = HTTPBearer()


def auth(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
):
    try:
        payload = decode_token(credentials.credentials)
    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Invalid token"
        )

    u = db.get(User, int(payload["sub"]))

    if not u or not u.is_active:
        raise HTTPException(
            status_code=401,
            detail="Inactive account"
        )

    return u
def role(*roles):
    def dep(u=Depends(auth)):
        if u.role not in roles: raise HTTPException(403,'Insufficient permission')
        return u
    return dep

def audit(db,u,action,entity,entity_id=None,old=None,new=None):
    db.add(AuditTrail(user_id=u.id if u else None,username=u.username if u else 'SYSTEM',action=action,entity=entity,entity_id=str(entity_id) if entity_id is not None else None,old_value=json.dumps(old,default=str) if old is not None else None,new_value=json.dumps(new,default=str) if new is not None else None))

def notify(db,user_id,title,message,kind='info',related_id=None):
    db.add(Notification(user_id=user_id,title=title,message=message,kind=kind,related_id=related_id))

def new_id(db, model, column, prefix):
    n=db.query(model).count()+1
    while db.query(model).filter(column==f'{prefix}-{n:05d}').first(): n+=1
    return f'{prefix}-{n:05d}'

def bootstrap_system(db: Session) -> bool:
    """Provision the local system-developer account and baseline reference data.

    Existing user accounts are never changed, except for the explicitly named
    bootstrap account when a one-time password reset is requested through the
    environment.  This makes an interrupted first setup recoverable without
    turning every application restart into a password reset.
    """
    if os.getenv('ALLOW_DEMO_SEED', '').lower() not in {'1', 'true', 'yes'}:
        return False
    username = os.getenv('BOOTSTRAP_USERNAME', '').strip()
    password = os.getenv('BOOTSTRAP_PASSWORD', '')
    full_name = os.getenv('BOOTSTRAP_FULL_NAME', 'System Programmer').strip()
    reset_password = os.getenv('BOOTSTRAP_RESET_PASSWORD', '').lower() in {'1', 'true', 'yes'}
    if not username or not password:
        raise RuntimeError('Bootstrap account environment variables are not configured')
    created = False
    programmer = db.query(User).filter(User.username == username).first()
    if not programmer:
        programmer = User(username=username, password_hash=hash_password(password), full_name=full_name, role='SYSTEM_DEVELOPER')
        db.add(programmer)
        created = True
    else:
        # The designated programmer account must retain full control, while
        # every other account stays untouched.
        programmer.full_name = full_name
        programmer.role = 'SYSTEM_DEVELOPER'
        programmer.is_active = True
        if reset_password:
            programmer.password_hash = hash_password(password)
        created = True

    if not db.query(Plant).filter(Plant.plant_id == 'PLANT-01').first():
        db.add(Plant(plant_id='PLANT-01',name='Main Plant'))
    if not db.query(PlantLine).filter(PlantLine.line_id == 'LINE-01').first():
        db.add(PlantLine(line_id='LINE-01',plant_id='PLANT-01',name='Production Line 01'))
    if not db.query(Technician).filter(Technician.technician_id == 'TECH-001').first():
        db.add(Technician(technician_id='TECH-001',name='Maintenance Technician'))
    if not db.query(Equipment).filter(Equipment.equipment_id == 'HM-001').first():
        db.add(Equipment(equipment_id='HM-001',name='Hammer Mill 01',equipment_type='Hammer Mill',plant_id='PLANT-01',line_id='LINE-01',status='Running'))
    db.commit()
    return created

@app.on_event('startup')
def create_bootstrap_system():
    db = SessionLocal()
    try:
        bootstrap_system(db)
        # Repair legacy technician logins that were created before the user
        # account screen began creating the matching technician profile.
        for account in db.query(User).filter(User.role.in_(tuple(TECHNICIAN))).all():
            provision_technician_profile(db, account)
        db.commit()
        try:
            release_due_corrective_orders(db)
        except Exception:
            db.rollback()
    finally:
        db.close()
    start_corrective_release_worker()

@app.get('/health')
def health(): return {'status':'ok','version':'2.0.0'}

@app.post('/login',response_model=LoginResponse)
def login(data:LoginRequest,db:Session=Depends(get_db)):
    u=db.query(User).filter(User.username==data.username).first()
    if not u or not u.is_active or not verify_password(data.password,u.password_hash): raise HTTPException(401,'Invalid username or password')
    u.last_login=datetime.utcnow(); db.commit()
    return {'access_token':create_access_token(u.id,u.username,u.role),'user_id':u.id,'username':u.username,'full_name':u.full_name,'role':u.role,'technician_id':u.technician_id}

@app.get('/me',response_model=UserOut)
def me(u=Depends(auth)): return u

def save_own_profile(db: Session, account: User, data: ProfileUpdate):
    """A person may change only their own name, username, and password."""
    full_name = (data.full_name or '').strip()
    username = (data.username or '').strip()
    if not full_name:
        raise HTTPException(400, 'Enter your name')
    if not username:
        raise HTTPException(400, 'Enter a username')
    if len(full_name) > 150 or len(username) > 80:
        raise HTTPException(400, 'Name or username is too long')
    taken = db.query(User).filter(func.lower(User.username) == username.lower(), User.id != account.id).first()
    if taken:
        raise HTTPException(409, 'Username exists')
    password = (data.password or '').strip()
    if password:
        if len(password) < 8:
            raise HTTPException(400, 'Password must be at least 8 characters')
        try:
            current_ok = bool(data.current_password) and verify_password(data.current_password, account.password_hash)
        except Exception:
            current_ok = False
        if not current_ok:
            raise HTTPException(400, 'Current password is incorrect')
        account.password_hash = hash_password(password)
    old = {'full_name': account.full_name, 'username': account.username}
    account.full_name = full_name
    account.username = username
    if account.technician_id:
        profile = db.query(Technician).filter(func.lower(Technician.technician_id) == account.technician_id.lower()).first()
        if profile:
            profile.name = full_name
    audit(db, account, 'UPDATE', 'User', account.username, old=old, new={'full_name': full_name, 'username': username, 'password_changed': bool(password)})
    db.commit()
    db.refresh(account)
    return account

@app.put('/me', response_model=UserOut)
def update_me(data: ProfileUpdate, db: Session = Depends(get_db), u=Depends(auth)):
    return save_own_profile(db, u, data)

@app.get('/users',response_model=list[UserOut])
def users(db:Session=Depends(get_db),u=Depends(role(*DEVELOPER))): return db.query(User).order_by(User.username).all()

def provision_technician_profile(db: Session, account: User):
    """Create/resolve the operational profile required by technician reports."""
    technician_id = (account.technician_id or '').strip()
    if not is_technician_account(account) or not technician_id:
        return None
    profile = db.query(Technician).filter(
        func.lower(Technician.technician_id) == technician_id.lower()
    ).first()
    if not profile:
        profile = Technician(
            technician_id=technician_id,
            name=account.full_name,
            status='Active',
        )
        db.add(profile)
        db.flush()
    account.technician_id = profile.technician_id
    return profile

@app.post('/users',response_model=UserOut)
def create_user(data:UserCreate,db:Session=Depends(get_db),u=Depends(role(*DEVELOPER))):
    if data.role not in ROLES: raise HTTPException(400,'Invalid role')
    if not data.password: raise HTTPException(400,'Password required')
    if data.role in TECHNICIAN and not (data.technician_id or '').strip():
        raise HTTPException(400, 'Technician ID is required for a technician account')
    if db.query(User).filter(User.username==data.username).first(): raise HTTPException(409,'Username exists')
    o=User(username=data.username,password_hash=hash_password(data.password),full_name=data.full_name,role=data.role,technician_id=data.technician_id,is_active=data.is_active)
    db.add(o)
    provision_technician_profile(db, o)
    audit(db,u,'CREATE','User',data.username,new=data.model_dump(exclude={'password'})); db.commit(); db.refresh(o); return o

@app.put('/users/{user_id}', response_model=UserOut)
def update_user(user_id:int, data:UserUpdate, db:Session=Depends(get_db), u=Depends(role(*DEVELOPER))):
    account = db.get(User, user_id)
    if not account:
        raise HTTPException(404, 'User not found')
    payload = data.model_dump(exclude_unset=True)
    if 'role' in payload and payload['role'] not in ROLES:
        raise HTTPException(400, 'Invalid role')
    if 'password' in payload:
        if not payload['password']:
            raise HTTPException(400, 'Password cannot be empty')
        payload['password_hash'] = hash_password(payload.pop('password'))
    old = {key: getattr(account, key) for key in payload if key != 'password_hash'}
    for key, value in payload.items():
        setattr(account, key, value)
    if is_technician_account(account) and not (account.technician_id or '').strip():
        raise HTTPException(400, 'Technician ID is required for a technician account')
    provision_technician_profile(db, account)
    audit(db, u, 'UPDATE', 'User', account.username, old=old, new=data.model_dump(exclude={'password'}, exclude_unset=True))
    db.commit(); db.refresh(account); return account

@app.get('/plants')
def plants(db:Session=Depends(get_db),u=Depends(auth)): return [as_dict(row) for row in db.query(Plant).order_by(Plant.name).all()]
@app.post('/plants')
def create_plant(data:PlantCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    plant_id = data.plant_id.strip()
    if not plant_id or not data.name.strip():
        raise HTTPException(400, 'Plant code and name are required')
    if db.query(Plant).filter_by(plant_id=plant_id).first():
        raise HTTPException(409, 'Plant ID already exists')
    o=Plant(plant_id=plant_id, name=data.name.strip(), active=data.active); db.add(o); audit(db,u,'CREATE','Plant',plant_id,new=data.model_dump()); db.commit(); db.refresh(o); return as_dict(o)

@app.put('/plants/{plant_id}')
def update_plant(plant_id: str, data: PlantUpdate, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    plant = db.query(Plant).filter_by(plant_id=plant_id).first()
    if not plant:
        raise HTTPException(404, 'Plant not found')
    old = plant.active
    plant.active = data.active
    audit(db, u, 'UPDATE', 'Plant', plant_id, old={'active': old}, new={'active': data.active})
    db.commit()
    db.refresh(plant)
    return as_dict(plant)

def active_plant_or_404(db, plant_id: str):
    plant = db.query(Plant).filter_by(plant_id=plant_id).first()
    if not plant:
        raise HTTPException(404, 'Plant not found')
    if plant.active is False:
        raise HTTPException(400, 'Choose an active plant')
    return plant
@app.get('/lines')
def lines(plant_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(PlantLine)
    if plant_id:q=q.filter(PlantLine.plant_id==plant_id)
    return [as_dict(row) for row in q.order_by(PlantLine.name).all()]
@app.post('/lines')
def create_line(data:LineCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    if data.line_number < 1:
        raise HTTPException(400, 'Line number must be 1 or greater')
    if not db.query(Plant).filter_by(plant_id=data.plant_id).first():
        raise HTTPException(404, 'Plant not found')
    if db.query(PlantLine).filter_by(plant_id=data.plant_id, line_number=data.line_number).first():
        raise HTTPException(409, 'This line number already exists in the plant')
    line_id = (data.line_id or f'{data.plant_id}-L{data.line_number}').strip()
    if db.query(PlantLine).filter_by(line_id=line_id).first():
        raise HTTPException(409, 'Line ID already exists')
    name = (data.name or '').strip() or f'Line {data.line_number}'
    o=PlantLine(line_id=line_id, plant_id=data.plant_id, line_number=data.line_number, name=name, active=data.active)
    db.add(o); audit(db,u,'CREATE','Line',line_id,new=data.model_dump()); db.commit(); db.refresh(o); return as_dict(o)

@app.get('/equipment',response_model=list[EquipmentOut])
def list_equipment(line_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(Equipment)
    if line_id:q=q.filter(Equipment.line_id==line_id)
    return q.order_by(Equipment.equipment_id).all()

@app.get('/equipment/lookup')
def lookup_equipment(code: str, plant_id: str | None = None, line_id: str | None = None, db: Session = Depends(get_db), u=Depends(auth)):
    """Resolve a typed equipment code for the Daily Report form."""
    clean_code = code.strip()
    if not clean_code:
        raise HTTPException(400, 'Equipment code is required')
    matches = db.query(Equipment).filter(
        func.lower(Equipment.equipment_id) == clean_code.lower()
    ).all()
    if plant_id:
        in_plant = [row for row in matches if row.plant_id == plant_id]
        if in_plant:
            matches = in_plant
    if line_id:
        on_line = [row for row in matches if row.line_id == line_id]
        if on_line:
            matches = on_line
    results = []
    for equipment in matches:
        plant = db.query(Plant).filter_by(plant_id=equipment.plant_id).first()
        line = db.query(PlantLine).filter_by(line_id=equipment.line_id).first()
        results.append({
            'equipment_id': equipment.equipment_id,
            'equipment_code': equipment.equipment_id,
            'equipment_name': equipment.name,
            'plant_id': equipment.plant_id,
            'plant_name': plant.name if plant else None,
            'line_id': equipment.line_id,
            'line_name': line.name if line else None,
            'line_number': line.line_number if line else None,
        })
    return {'matches': results}

STATUSES = {
    "Open",
    "In Progress",
    "Completed",
    "Cancelled",
    "Closed",
    "Overdue",
}
EQUIPMENT_STATUSES = {
    "Running",
    "Operational",
    "Under Maintenance",
    "Out of Service",
}

def as_dict(obj):
    return {column.name: getattr(obj, column.name) for column in obj.__table__.columns}
@app.post('/equipment',response_model=EquipmentOut)
def create_equipment(data:EquipmentCreate,db:Session=Depends(get_db),u=Depends(auth)):
    if u.role not in ENGINEER and not is_technician_account(u):
        raise HTTPException(403, 'Insufficient permission')
    if not data.plant_id or not data.line_id:
        raise HTTPException(400, 'Select a plant and then a line number')
    active_plant_or_404(db, data.plant_id)
    if not db.query(PlantLine).filter_by(line_id=data.line_id, plant_id=data.plant_id).first():
        raise HTTPException(400, 'The line number does not belong to the selected plant')
    if data.status not in EQUIPMENT_STATUSES: raise HTTPException(400,'Invalid equipment status')
    if db.query(Equipment).filter_by(equipment_id=data.equipment_id).first(): raise HTTPException(409,'Equipment ID already exists')
    o=Equipment(**data.model_dump()); db.add(o); audit(db,u,'CREATE','Equipment',data.equipment_id,new=data.model_dump()); db.commit(); db.refresh(o); return o
@app.put('/equipment/{equipment_id}',response_model=EquipmentOut)
def update_equipment(equipment_id:str,data:EquipmentCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    o=db.query(Equipment).filter_by(equipment_id=equipment_id).first()
    if not o: raise HTTPException(404,'Equipment not found')
    old={k:getattr(o,k) for k in data.model_dump()}
    for k,v in data.model_dump().items():
        if k!='equipment_id': setattr(o,k,v)
    audit(db,u,'UPDATE','Equipment',equipment_id,old=old,new=data.model_dump()); db.commit(); db.refresh(o); return o

@app.get('/pending-equipment')
def pending_equipment(db: Session = Depends(get_db), u=Depends(auth)):
    if u.role not in ENGINEER and u.role != 'LUBRICATION_TECHNICIAN':
        raise HTTPException(403, 'Insufficient permission')
    rows = db.query(PendingEquipment).filter_by(status='Pending').order_by(PendingEquipment.id.desc()).all()
    return [as_dict(row) for row in rows]

@app.post('/pending-equipment/{item_id}/approve')
def approve_pending_equipment(item_id: int, plant_id: str | None = None, line_id: str | None = None, name: str | None = None, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    row = db.get(PendingEquipment, item_id)
    if not row or row.status != 'Pending':
        raise HTTPException(404, 'Pending equipment was not found')
    if db.query(Equipment).filter(func.lower(Equipment.equipment_id) == row.equipment_code.lower()).first():
        raise HTTPException(409, 'This equipment code is already registered')
    if name and name.strip():
        row.equipment_name = name.strip()[:150]
    if not (row.equipment_name or '').strip():
        raise HTTPException(400, 'Enter the equipment name before approving it.')
    if plant_id:
        row.plant_id = plant_id.strip()
    if line_id:
        row.line_id = line_id.strip()
    line = None
    if row.line_id:
        line = db.query(PlantLine).filter_by(line_id=row.line_id, plant_id=row.plant_id).first()
    if line is None and row.plant_id and row.line_number and str(row.line_number).isdigit():
        line = db.query(PlantLine).filter_by(plant_id=row.plant_id, line_number=int(row.line_number)).first()
    if line is not None:
        row.line_id = line.line_id
        row.line_number = str(line.line_number) if line.line_number is not None else row.line_number
    if not row.plant_id or line is None:
        raise HTTPException(400, 'Select a plant and a line before approving this equipment.')
    active_plant_or_404(db, row.plant_id)
    equipment = Equipment(
        equipment_id=row.equipment_code,
        name=row.equipment_name,
        equipment_type='Reported',
        plant_id=row.plant_id,
        line_id=line.line_id,
        status='Running',
        criticality='B',
    )
    db.add(equipment)
    row.status = 'Approved'
    row.line_id = line.line_id
    audit(db, u, 'APPROVE', 'PendingEquipment', row.equipment_code, new=as_dict(row))
    db.commit()
    return as_dict(equipment)

@app.post('/pending-equipment/{item_id}/reject')
def reject_pending_equipment(item_id: int, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    row = db.get(PendingEquipment, item_id)
    if not row or row.status != 'Pending':
        raise HTTPException(404, 'Pending equipment was not found')
    row.status = 'Rejected'
    audit(db, u, 'REJECT', 'PendingEquipment', row.equipment_code, new={'status': 'Rejected'})
    db.commit()
    return as_dict(row)

@app.get('/components',response_model=list[ComponentOut])
def components(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(Component)
    if equipment_id:q=q.filter(Component.equipment_id==equipment_id)
    return q.order_by(Component.component_id).all()
@app.post('/components',response_model=ComponentOut)
def create_component(data:ComponentCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    if not db.query(Equipment).filter_by(equipment_id=data.equipment_id).first(): raise HTTPException(404,'Equipment not found')
    n=db.query(Component).filter(Component.equipment_id==data.equipment_id).count()+1
    cid=f'{data.equipment_id}-C{n:03d}'
    while db.query(Component).filter_by(component_id=cid).first(): n+=1; cid=f'{data.equipment_id}-C{n:03d}'
    o=Component(component_id=cid,**data.model_dump()); db.add(o); audit(db,u,'CREATE','Component',cid,new=data.model_dump()); db.commit(); db.refresh(o); return o

@app.get('/technicians',response_model=list[TechnicianOut])
def technicians(db:Session=Depends(get_db),u=Depends(auth)): return db.query(Technician).order_by(Technician.name).all()
@app.post('/technicians',response_model=TechnicianOut)
def create_technician(data:TechnicianCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    o=Technician(**data.model_dump()); db.add(o); audit(db,u,'CREATE','Technician',data.technician_id,new=data.model_dump()); db.commit(); db.refresh(o); return o

@app.get('/pm',response_model=list[PMOut])
def pm_list(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(PMPlan)
    if equipment_id:q=q.filter(PMPlan.equipment_id==equipment_id)
    return q.order_by(PMPlan.next_due_date).all()
@app.post('/pm',response_model=PMOut)
def create_pm(data:PMCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    if not data.equipment_id and not data.manual_equipment_code:
        raise HTTPException(400, 'Equipment or manual equipment code is required')
    if data.equipment_id and not db.query(Equipment).filter_by(equipment_id=data.equipment_id).first():
        raise HTTPException(404,'Equipment not found')
    equipment_code = data.equipment_id or data.manual_equipment_code
    pid=f'PM-{equipment_code}-{db.query(PMPlan).filter(or_(PMPlan.equipment_id==data.equipment_id, PMPlan.manual_equipment_code==data.manual_equipment_code)).count()+1:03d}'
    o=PMPlan(pm_id=pid,**data.model_dump()); db.add(o); audit(db,u,'CREATE','PM',pid,new=data.model_dump()); db.commit(); db.refresh(o); return o

def register_plan_equipment(db, user, plant_id: str, code: str, name: str, maintenance_type: str):
    """Use a registered machine name, or add a new one from a preventive task."""
    code = (code or '').strip()[:50]
    name = (name or '').strip()[:150]
    if not code:
        return code, name, False
    found = db.query(Equipment).filter(func.lower(Equipment.equipment_id) == code.lower()).first()
    if found:
        return found.equipment_id, found.name, False
    if maintenance_type != 'Preventive' or not name:
        return code, name, False
    created = Equipment(
        equipment_id=code,
        name=name,
        equipment_type='Machine',
        plant_id=plant_id,
        criticality='B',
        status='Running',
        notes='Added from the preventive maintenance plan.',
    )
    db.add(created)
    db.flush()
    audit(db, user, 'CREATE', 'Equipment', code, new={'name': name, 'plant_id': plant_id, 'source': 'Preventive plan'})
    for engineer in db.query(User).filter(User.role.in_(tuple(ENGINEER)), User.is_active == True).all():
        notify(db, engineer.id, 'معدات جديدة', f'{code} — {name} أُضيفت إلى النظام من خطة الصيانة الوقائية.', 'equipment', code)
    return code, name, True

def clean_annual_weeks(raw: str) -> str:
    marks = []
    for part in (raw or '').split(','):
        piece = part.strip()
        if not piece:
            continue
        month_text, _, week_text = piece.partition('-')
        if not month_text.isdigit() or not week_text.isdigit():
            continue
        month, week = int(month_text), int(week_text)
        if 1 <= month <= 12 and 1 <= week <= 4:
            token = f'{month}-{week}'
            if token not in marks:
                marks.append(token)
    return ','.join(marks)

def repeat_every_days(year: int, raw: str) -> list[date]:
    """Return each date in the year when the interval is a whole number of days."""
    text = (raw or '').strip()
    if not text.isdigit():
        return []
    step = int(text)
    if step < 1 or step > 366:
        return []
    cursor = date(year, 1, 1)
    end = date(year, 12, 31)
    found = []
    while cursor <= end:
        found.append(cursor)
        cursor += timedelta(days=step)
    return found

def week_token(value: date) -> str:
    if value.day <= 7:
        week = 1
    elif value.day <= 14:
        week = 2
    elif value.day <= 21:
        week = 3
    else:
        week = 4
    return f'{value.month}-{week}'

def drop_generated_task(db, row):
    cancel_unreleased_order(db, row)
    if not row.released_at:
        db.delete(row)

def sync_repeated_day_tasks(db, user, plan, plant_id: str):
    """Place each annual task on every repeated date and keep its maintenance type."""
    items = db.query(AnnualPMItem).filter_by(plan_id=plan.id).all()
    kept = {item.line_key for item in items if item.line_key}
    for item in items:
        if not item.line_key:
            continue
        dates = repeat_every_days(plan.year, item.frequency_time)
        existing = {
            row.work_date: row
            for row in db.query(AnnualPMDayTask).filter_by(plan_id=plan.id, source_key=item.line_key).all()
        }
        if not dates or (not item.machine_code and not item.machine_name):
            for row in existing.values():
                drop_generated_task(db, row)
            continue
        item.days = ','.join(value.isoformat() for value in dates)
        item.weeks = ','.join(dict.fromkeys(week_token(value) for value in dates))
        wanted = set(dates)
        for work_date, row in existing.items():
            if work_date not in wanted:
                drop_generated_task(db, row)
                continue
            if row.released_at:
                continue
            row.machine_code = item.machine_code
            row.machine_name = item.machine_name
            row.task = item.task
            row.maintenance_type = item.maintenance_type or 'Preventive'
            sync_corrective_work_order(db, user, plant_id, row)
        for work_date in dates:
            if work_date in existing:
                continue
            row = AnnualPMDayTask(
                plan_id=plan.id,
                work_date=work_date,
                sort_order=1,
                machine_code=item.machine_code,
                machine_name=item.machine_name,
                task=item.task,
                maintenance_type=item.maintenance_type or 'Preventive',
                source_key=item.line_key,
            )
            db.add(row)
            db.flush()
            sync_corrective_work_order(db, user, plant_id, row)
    db.flush()
    stale = db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.plan_id == plan.id,
        AnnualPMDayTask.source_key != '',
    )
    if kept:
        stale = stale.filter(AnnualPMDayTask.source_key.notin_(kept))
    for row in stale.all():
        drop_generated_task(db, row)

def clean_annual_days(raw: str, year: int) -> str:
    marks = []
    for part in (raw or '').split(','):
        piece = part.strip()
        try:
            value = date.fromisoformat(piece)
        except ValueError:
            continue
        if value.year == year and piece not in marks:
            marks.append(piece)
    return ','.join(marks)

def pack_plan_tasks(rows, limit=80, plant_names=None):
    shown = rows[:limit]
    items = []
    for row in shown:
        item = {
            'work_date': row.work_date.isoformat(),
            'machine_code': row.machine_code,
            'machine_name': row.machine_name,
            'task': row.task,
            'maintenance_type': row.maintenance_type or 'Preventive',
        }
        if plant_names is not None:
            item['plant_name'] = plant_names.get(row.plan_id) or ''
        items.append(item)
    return {'count': len(rows), 'items': items}

@app.get('/annual-pm/overview')
def annual_pm_overview(year: int, plant_id: str | None = None, db: Session = Depends(get_db), u=Depends(auth)):
    """Tasks that fall today, this week, and this month, plus task counts per plant."""
    today = date.today()
    plant_rows = db.query(Plant).all()
    names = {row.plant_id: row.name for row in plant_rows}
    active_ids = {row.plant_id for row in plant_rows if row.active is not False}
    counted = db.query(AnnualPMPlan.plant_id, func.count(AnnualPMItem.id)).outerjoin(
        AnnualPMItem,
        and_(AnnualPMItem.plan_id == AnnualPMPlan.id, AnnualPMItem.task != ''),
    ).filter(AnnualPMPlan.year == year).group_by(AnnualPMPlan.plant_id).all()
    plants = [{
        'plant_id': plant,
        'name': names.get(plant) or plant,
        'tasks': count or 0,
    } for plant, count in counted if plant in active_ids]
    plants.sort(key=lambda row: row['name'].lower())
    empty = {'count': 0, 'items': []}
    payload = {
        'on': today.isoformat(),
        'in_year': today.year == year,
        'week_number': 0,
        'week_from': '',
        'week_to': '',
        'month_number': today.month,
        'today': empty,
        'week': empty,
        'month': empty,
        'plants': plants,
    }
    if today.year != year:
        return payload
    plans = db.query(AnnualPMPlan).filter(AnnualPMPlan.year == year)
    if plant_id:
        plans = plans.filter(AnnualPMPlan.plant_id == plant_id)
    plan_rows = [row for row in plans.all() if row.plant_id in active_ids]
    if not plan_rows:
        return payload
    month_start = today.replace(day=1)
    month_end = (month_start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    week = 1 if today.day <= 7 else 2 if today.day <= 14 else 3 if today.day <= 21 else 4
    week_start_day = (week - 1) * 7 + 1
    week_end_day = month_end.day if week == 4 else min(week_start_day + 6, month_end.day)
    week_start = today.replace(day=week_start_day)
    week_end = today.replace(day=week_end_day)
    rows = db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.plan_id.in_([row.id for row in plan_rows]),
        AnnualPMDayTask.work_date >= month_start,
        AnnualPMDayTask.work_date <= month_end,
    ).order_by(AnnualPMDayTask.work_date, AnnualPMDayTask.sort_order, AnnualPMDayTask.id).all()
    plant_names = None if plant_id else {row.id: names.get(row.plant_id) or row.plant_id for row in plan_rows}
    payload.update({
        'week_number': week,
        'week_from': week_start.isoformat(),
        'week_to': week_end.isoformat(),
        'today': pack_plan_tasks([row for row in rows if row.work_date == today], plant_names=plant_names),
        'week': pack_plan_tasks([row for row in rows if week_start <= row.work_date <= week_end], plant_names=plant_names),
        'month': pack_plan_tasks(rows, limit=120, plant_names=plant_names),
    })
    return payload

def due_task_status(task, today: date, completed: bool) -> str:
    if completed:
        return 'Completed'
    if task.work_date < today:
        return 'Overdue'
    if task.work_date == today:
        return 'Due Today'
    if task.work_date <= today + timedelta(days=7):
        return 'Due This Week'
    if task.work_date.year == today.year and task.work_date.month == today.month:
        return 'Due This Month'
    return 'Upcoming'

@app.get('/annual-pm/due')
def annual_pm_due(year: int, plant_id: str | None = None, db: Session = Depends(get_db), u=Depends(auth)):
    """Real due, overdue, completed, and compliance figures for the annual plan."""
    today = date.today()
    plans = db.query(AnnualPMPlan).filter(AnnualPMPlan.year == year)
    if plant_id:
        plans = plans.filter(AnnualPMPlan.plant_id == plant_id)
    plan_rows = plans.all()
    plan_plant = {row.id: row.plant_id for row in plan_rows}
    names = {row.plant_id: row.name for row in db.query(Plant).all()}
    tasks = []
    if plan_plant:
        tasks = db.query(AnnualPMDayTask).filter(AnnualPMDayTask.plan_id.in_(plan_plant)).order_by(
            AnnualPMDayTask.work_date, AnnualPMDayTask.sort_order, AnnualPMDayTask.id
        ).all()
    order_ids = [row.work_order_id for row in tasks if row.work_order_id]
    orders = {
        row.work_order_id: row
        for row in db.query(WorkOrder).filter(WorkOrder.work_order_id.in_(order_ids)).all()
    } if order_ids else {}
    done_reports = db.query(DailyReportItem, DailyReport.report_date).join(
        DailyReport, DailyReport.id == DailyReportItem.report_id
    ).filter(
        DailyReportItem.maintenance_completed == True,
        DailyReport.report_date >= date(year, 1, 1),
        DailyReport.report_date <= date(year, 12, 31),
    ).all() if tasks else []
    done_by_order = {}
    done_on_day = {}
    for item, report_date in done_reports:
        if item.wo_id:
            done_by_order.setdefault(item.wo_id, []).append(report_date)
        code = (item.equipment_code or item.equipment_id or '').strip().lower()
        if code:
            done_on_day.setdefault((code, report_date.isoformat(), item.maintenance_type), True)
    items = []
    completed_count = overdue_count = due_month = on_time = due_to_date = 0
    for task in tasks:
        finished = None
        completed = False
        order = orders.get(task.work_order_id) if task.work_order_id else None
        if order and order.status in ('Completed', 'Closed'):
            completed = True
            finished = order.closing_date.date() if order.closing_date else (order.end_time.date() if order.end_time else None)
        elif task.work_order_id and task.work_order_id in done_by_order:
            completed = True
            finished = min(done_by_order[task.work_order_id])
        elif done_on_day.get(((task.machine_code or '').strip().lower(), task.work_date.isoformat(), task.maintenance_type or 'Preventive')):
            completed = True
            finished = task.work_date
        status = due_task_status(task, today, completed)
        if completed:
            completed_count += 1
        if status == 'Overdue':
            overdue_count += 1
        if status in ('Due Today', 'Due This Week', 'Due This Month') and task.work_date.month == today.month and task.work_date.year == today.year:
            due_month += 1
        if task.work_date <= today:
            due_to_date += 1
            if completed and (finished is None or finished <= task.work_date):
                on_time += 1
        plant = plan_plant.get(task.plan_id)
        items.append({
            'id': task.id,
            'work_date': task.work_date.isoformat(),
            'machine_code': task.machine_code,
            'machine_name': task.machine_name,
            'task': task.task,
            'maintenance_type': task.maintenance_type or 'Preventive',
            'plant_id': plant,
            'plant_name': names.get(plant) or plant or '',
            'status': status,
            'work_order_id': task.work_order_id,
        })
    compliance = round(on_time * 100 / due_to_date, 1) if due_to_date else None
    return {
        'total': len(items),
        'due_month': due_month,
        'overdue': overdue_count,
        'completed': completed_count,
        'compliance': compliance,
        'items': items,
    }

@app.get('/annual-pm', response_model=AnnualPMOut)
def annual_pm(plant_id: str, year: int, db: Session = Depends(get_db), u=Depends(auth)):
    plan = db.query(AnnualPMPlan).filter_by(plant_id=plant_id, year=year).first()
    items = []
    if plan:
        items = db.query(AnnualPMItem).filter_by(plan_id=plan.id).order_by(AnnualPMItem.sort_order, AnnualPMItem.id).all()
    return {'plant_id': plant_id, 'year': year, 'items': items}

@app.put('/annual-pm', response_model=AnnualPMOut)
def save_annual_pm(data: AnnualPMSave, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    active_plant_or_404(db, data.plant_id)
    if data.year < 2000 or data.year > 2100:
        raise HTTPException(400, 'Choose a year between 2000 and 2100')
    if len(data.items) > 400:
        raise HTTPException(400, 'A plan can hold up to 400 tasks')
    cleaned = []
    created_equipment = []
    for item in data.items:
        machine_code = item.machine_code.strip()[:80]
        machine_name = item.machine_name.strip()[:150]
        task = item.task.strip()
        frequency_time = item.frequency_time.strip()[:40]
        frequency_hours = item.frequency_hours.strip()[:40]
        maintenance_type = (item.maintenance_type or 'Preventive').strip()
        line_key = item.line_key.strip()[:40]
        weeks = clean_annual_weeks(item.weeks)
        days = clean_annual_days(item.days, data.year)
        repeated = repeat_every_days(data.year, frequency_time)
        if not any([machine_code, machine_name, task, frequency_time, frequency_hours, weeks, days]):
            continue
        if not task:
            raise HTTPException(400, 'Each plan row needs a task description')
        if repeated and not machine_code and not machine_name:
            raise HTTPException(400, 'A repeated task needs an equipment number or name')
        if maintenance_type not in MAINT_TYPES:
            raise HTTPException(400, 'Choose a maintenance type.')
        machine_code, machine_name, added = register_plan_equipment(db, u, data.plant_id, machine_code, machine_name, maintenance_type)
        if added:
            created_equipment.append(machine_code)
        cleaned.append({
            'machine_code': machine_code,
            'machine_name': machine_name,
            'task': task,
            'frequency_time': frequency_time,
            'frequency_hours': frequency_hours,
            'maintenance_type': maintenance_type,
            'line_key': line_key,
            'weeks': weeks,
            'days': days,
        })
    plan = db.query(AnnualPMPlan).filter_by(plant_id=data.plant_id, year=data.year).first()
    if not plan:
        plan = AnnualPMPlan(plant_id=data.plant_id, year=data.year)
        db.add(plan)
        db.flush()
    db.query(AnnualPMItem).filter_by(plan_id=plan.id).delete()
    seen_keys = set()
    for index, item in enumerate(cleaned):
        line_key = item['line_key']
        if not line_key or line_key in seen_keys:
            line_key = f'L{index}-{secrets.token_hex(4)}'
            item['line_key'] = line_key
        seen_keys.add(line_key)
        db.add(AnnualPMItem(plan_id=plan.id, sort_order=index, **item))
    db.flush()
    sync_repeated_day_tasks(db, u, plan, data.plant_id)
    audit(db, u, 'SAVE', 'AnnualPM', f'{data.plant_id}-{data.year}', new={'tasks': len(cleaned)})
    db.commit()
    items = db.query(AnnualPMItem).filter_by(plan_id=plan.id).order_by(AnnualPMItem.sort_order, AnnualPMItem.id).all()
    return {'plant_id': data.plant_id, 'year': data.year, 'items': items, 'new_equipment': created_equipment}

def annual_plan_for(db: Session, plant_id: str, year: int) -> AnnualPMPlan:
    plan = db.query(AnnualPMPlan).filter_by(plant_id=plant_id, year=year).first()
    if plan:
        return plan
    plan = AnnualPMPlan(plant_id=plant_id, year=year)
    db.add(plan)
    db.flush()
    return plan

def equipment_for_day_task(db, plant_id, machine_code):
    code = (machine_code or '').strip()
    if not code:
        return None
    found = db.query(Equipment).filter(
        func.lower(Equipment.equipment_id) == code.lower(),
        Equipment.plant_id == plant_id,
    ).first()
    if found:
        return found
    return db.query(Equipment).filter(func.lower(Equipment.equipment_id) == code.lower()).first()

def cancel_unreleased_order(db, task):
    """Drop a corrective order that has not been sent to a technician yet."""
    if task.released_at or not task.work_order_id:
        return
    order = db.query(WorkOrder).filter_by(work_order_id=task.work_order_id).first()
    if order and order.status == 'Open' and not order.assigned_technician_id:
        order.status = 'Cancelled'
    task.work_order_id = None

def fill_order_equipment(order, equipment, plant_id, machine_code, machine_name):
    if equipment:
        order.equipment_id = equipment.equipment_id
        order.manual_equipment_code = None
        order.manual_equipment_name = None
        order.manual_plant_id = None
        return
    order.equipment_id = None
    order.manual_equipment_code = machine_code or machine_name or None
    order.manual_equipment_name = machine_name or None
    order.manual_plant_id = plant_id

def active_technician_ids(db):
    return [
        row.technician_id
        for row in db.query(Technician).filter(Technician.status == 'Active').order_by(Technician.id).all()
        if row.technician_id
    ]

def release_task_order(db, task):
    """Send the corrective order to every active technician the day before its date."""
    if task.maintenance_type != 'Corrective' or not task.work_order_id or task.released_at:
        return False
    if task.work_date > date.today() + timedelta(days=1):
        return False
    technician_ids = active_technician_ids(db)
    if not technician_ids:
        return False
    order = db.query(WorkOrder).filter_by(work_order_id=task.work_order_id).first()
    if not order or order.status in ('Cancelled', 'Closed', 'Completed'):
        return False
    apply_assignment(db, None, order, technician_ids, had_assignees=False)
    task.released_at = datetime.utcnow()
    task.technician_id = None
    return True

def sync_corrective_work_order(db, user, plant_id, task):
    if task.maintenance_type != 'Corrective':
        cancel_unreleased_order(db, task)
        if not task.released_at:
            task.technician_id = None
        return
    task.technician_id = None
    equipment = equipment_for_day_task(db, plant_id, task.machine_code)
    order = db.query(WorkOrder).filter_by(work_order_id=task.work_order_id).first() if task.work_order_id else None
    if order and order.status == 'Cancelled':
        order = None
        task.work_order_id = None
        task.released_at = None
    if order and task.released_at:
        return
    if order is None:
        order = WorkOrder(
            work_order_id=next_work_order_id(db, task.work_date.year),
            work_order_type='Corrective',
            priority='Medium',
            status='Open',
            problem_description=task.task,
            work_description=task.task,
            planned_date=task.work_date,
            request_date=date.today(),
            created_by=user.username if user else 'SYSTEM',
        )
        fill_order_equipment(order, equipment, plant_id, task.machine_code, task.machine_name)
        db.add(order)
        db.flush()
        task.work_order_id = order.work_order_id
        audit(db, user, 'CREATE', 'WorkOrder', order.work_order_id, new={'source': 'Annual plan', 'planned_date': str(task.work_date)})
    else:
        order.work_order_type = 'Corrective'
        order.problem_description = task.task
        order.work_description = task.task
        order.planned_date = task.work_date
        fill_order_equipment(order, equipment, plant_id, task.machine_code, task.machine_name)
    release_task_order(db, task)

def release_due_corrective_orders(db):
    """Assign corrective plan orders on the day before their scheduled date."""
    due = db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.maintenance_type == 'Corrective',
        AnnualPMDayTask.work_order_id.isnot(None),
        AnnualPMDayTask.released_at.is_(None),
        AnnualPMDayTask.work_date <= date.today() + timedelta(days=1),
    ).all()
    sent = 0
    for task in due:
        if release_task_order(db, task):
            sent += 1
    if sent:
        db.commit()
    return sent

def start_corrective_release_worker():
    if getattr(start_corrective_release_worker, 'started', False):
        return
    start_corrective_release_worker.started = True

    def loop():
        while True:
            time.sleep(900)
            session = SessionLocal()
            try:
                release_due_corrective_orders(session)
            except Exception:
                session.rollback()
            finally:
                session.close()

    threading.Thread(target=loop, name='corrective-release', daemon=True).start()

@app.get('/annual-pm/days', response_model=list[AnnualDayTaskOut])
def annual_pm_days(plant_id: str, year: int, date_from: date, date_to: date, db: Session = Depends(get_db), u=Depends(auth)):
    release_due_corrective_orders(db)
    plan = db.query(AnnualPMPlan).filter_by(plant_id=plant_id, year=year).first()
    if not plan:
        return []
    return db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.plan_id == plan.id,
        AnnualPMDayTask.work_date >= date_from,
        AnnualPMDayTask.work_date <= date_to,
    ).order_by(AnnualPMDayTask.work_date, AnnualPMDayTask.sort_order, AnnualPMDayTask.id).all()

@app.put('/annual-pm/days', response_model=list[AnnualDayTaskOut])
def save_annual_pm_days(data: AnnualDaySave, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    active_plant_or_404(db, data.plant_id)
    if data.date_from.year != data.year or data.date_to.year != data.year or data.date_from > data.date_to:
        raise HTTPException(400, 'The week dates must stay inside the selected year')
    if len(data.items) > 300:
        raise HTTPException(400, 'A week can hold up to 300 tasks')
    cleaned = []
    for item in data.items:
        machine_code = item.machine_code.strip()[:80]
        machine_name = item.machine_name.strip()[:150]
        task = item.task.strip()
        maintenance_type = (item.maintenance_type or 'Preventive').strip()
        if not any([machine_code, machine_name, task]):
            continue
        if item.work_date < data.date_from or item.work_date > data.date_to:
            raise HTTPException(400, 'A task date is outside this week')
        if not task:
            raise HTTPException(400, 'Each task needs a description of the work')
        if not machine_code and not machine_name:
            raise HTTPException(400, 'Each task needs an equipment number or name')
        if maintenance_type not in MAINT_TYPES:
            raise HTTPException(400, 'Choose a maintenance type.')
        machine_code, machine_name, _added = register_plan_equipment(db, u, data.plant_id, machine_code, machine_name, maintenance_type)
        cleaned.append({
            'id': item.id,
            'work_date': item.work_date,
            'machine_code': machine_code,
            'machine_name': machine_name,
            'task': task,
            'maintenance_type': maintenance_type,
        })
    plan = annual_plan_for(db, data.plant_id, data.year)
    existing_rows = db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.plan_id == plan.id,
        AnnualPMDayTask.work_date >= data.date_from,
        AnnualPMDayTask.work_date <= data.date_to,
    ).all()
    existing = {row.id: row for row in existing_rows}
    kept = set()
    order = {}
    for item in cleaned:
        key = item['work_date']
        order[key] = order.get(key, 0) + 1
        row = existing.get(item['id']) if item['id'] else None
        if row is None:
            row = AnnualPMDayTask(plan_id=plan.id)
            db.add(row)
        else:
            kept.add(row.id)
        row.sort_order = order[key]
        row.work_date = item['work_date']
        row.machine_code = item['machine_code']
        row.machine_name = item['machine_name']
        row.task = item['task']
        row.maintenance_type = item['maintenance_type']
        sync_corrective_work_order(db, u, data.plant_id, row)
    for row in existing_rows:
        if row.id not in kept:
            cancel_unreleased_order(db, row)
            db.delete(row)
    audit(db, u, 'SAVE', 'AnnualPMDay', f'{data.plant_id}-{data.year}', new={'tasks': len(cleaned)})
    db.commit()
    return db.query(AnnualPMDayTask).filter(
        AnnualPMDayTask.plan_id == plan.id,
        AnnualPMDayTask.work_date >= data.date_from,
        AnnualPMDayTask.work_date <= data.date_to,
    ).order_by(AnnualPMDayTask.work_date, AnnualPMDayTask.sort_order, AnnualPMDayTask.id).all()

@app.get('/sops')
def sops(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(SOP)
    if equipment_id:q=q.filter(SOP.equipment_id==equipment_id)
    return [as_dict(row) for row in q.order_by(SOP.sop_id).all()]
@app.post('/sops')
def create_sop(data:SOPCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    sid=f'SOP-{data.equipment_id}-{db.query(SOP).filter(SOP.equipment_id==data.equipment_id).count()+1:03d}'
    o=SOP(sop_id=sid,**data.model_dump()); db.add(o); audit(db,u,'CREATE','SOP',sid,new=data.model_dump()); db.commit(); db.refresh(o); return o

def visible_to_technician(query, technician_id):
    """A technician sees a work order only when it was sent to that technician."""
    if not technician_id:
        return query.filter(WorkOrder.id == -1)
    linked = db_assignment_ids(query.session, technician_id)
    return query.filter(or_(WorkOrder.work_order_id.in_(linked), WorkOrder.assigned_technician_id == technician_id))

def db_assignment_ids(db, technician_id):
    return db.query(WorkOrderAssignment.work_order_id).filter(WorkOrderAssignment.technician_id == technician_id)

@app.get('/kpi')
def kpi_dashboard(
    plant_id: str | None = None,
    line_id: str | None = None,
    equipment_id: str | None = None,
    technician_id: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    if is_technician_account(u) and u.technician_id:
        technician_id = u.technician_id
    payload = compute_kpi(db, plant_id or None, line_id or None, equipment_id or None, technician_id or None, date_from, date_to)
    period = payload.get('period') or {}
    start = date.fromisoformat(period['from']) if period.get('from') else date.today()
    end = date.fromisoformat(period['to']) if period.get('to') else date.today()
    payload['motor'] = motor_chart(db, plant_id or None, line_id or None, equipment_id or None, start, end)
    return payload

@app.put('/kpi/targets')
def update_kpi_target(data: KpiTargetIn, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    metric = data.metric.strip()
    allowed = {
        'availability', 'mtbf', 'mttr', 'pm_compliance', 'downtime_h', 'pm_overdue',
        'planned_pm_pct', 'corrective_pct', 'preventive_pct', 'wo_schedule', 'wo_completion',
        'wo_overdue', 'failure_rate_1000h',
    }
    if metric not in allowed:
        raise HTTPException(400, 'Unknown KPI')
    row = save_kpi_target(
        db, metric, data.target_value,
        data.plant_id or None, data.line_id or None, data.equipment_id or None,
    )
    return {'metric': row.metric, 'target_value': row.target_value}

@app.get('/work-orders',response_model=list[WOOut])
def work_orders(status:str|None=None,equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    release_due_corrective_orders(db)
    expire_pending_assignments(db)
    q=db.query(WorkOrder)
    if status:q=q.filter(WorkOrder.status==status)
    if equipment_id:q=q.filter(WorkOrder.equipment_id==equipment_id)
    if is_technician_account(u):
        q = visible_to_technician(q, u.technician_id)
    return q.order_by(WorkOrder.id.desc()).all()
def _plan_cycle_days(plan):
    unit = {'Daily': 1, 'Weekly': 7, 'Monthly': 30, 'Annual': 365}.get(plan.frequency or 'Annual', 365)
    return unit * max(plan.frequency_value or 1, 1)

def consume_annual_plan(db, work_order, done_on):
    """Move a matching annual PM occurrence forward once the work is assigned."""
    plan = None
    if work_order.pm_id:
        linked = db.query(PMPlan).filter_by(pm_id=work_order.pm_id, active=True).first()
        if linked and linked.frequency == 'Annual':
            plan = linked
    if plan is None:
        query = db.query(PMPlan).filter(PMPlan.active == True, PMPlan.frequency == 'Annual')
        if work_order.equipment_id:
            query = query.filter(PMPlan.equipment_id == work_order.equipment_id)
        elif work_order.manual_equipment_code:
            query = query.filter(PMPlan.manual_equipment_code == work_order.manual_equipment_code)
        else:
            return None
        plan = query.order_by(PMPlan.next_due_date).first()
    if not plan:
        return None
    plan.last_pm_date = done_on
    plan.next_due_date = done_on + timedelta(days=_plan_cycle_days(plan))
    work_order.pm_id = plan.pm_id
    return plan

def record_high_machine(db, work_order, technician_id, action=None):
    """Machine history is kept only for High corrective or emergency work."""
    if work_order.work_order_type not in {'Corrective', 'Emergency'} or work_order.priority != 'High':
        return None
    existing = db.query(MachineRecord).filter_by(wo_id=work_order.work_order_id).first()
    if existing:
        if action:
            existing.action = action
            existing.description = action
        return existing
    equipment_id = work_order.equipment_id or work_order.manual_equipment_code
    if not equipment_id:
        return None
    record = MachineRecord(
        equipment_id=equipment_id,
        record_date=work_order.planned_date or date.today(),
        record_type=work_order.work_order_type,
        wo_id=work_order.work_order_id,
        pm_id=work_order.pm_id,
        technician_id=technician_id,
        description=work_order.problem_description or work_order.work_description,
        cause=work_order.failure_cause or work_order.problem_description,
        action=action,
    )
    db.add(record)
    return record

def current_assignees(db, work_order):
    rows = db.query(WorkOrderAssignment).filter_by(work_order_id=work_order.work_order_id).order_by(WorkOrderAssignment.id).all()
    ids = [row.technician_id for row in rows]
    if work_order.assigned_technician_id and work_order.assigned_technician_id not in ids:
        ids.insert(0, work_order.assigned_technician_id)
    return ids

def replace_assignees(db, work_order, technician_ids):
    cleaned = []
    for raw in technician_ids or []:
        technician_id = (raw or '').strip()
        if technician_id and technician_id not in cleaned:
            cleaned.append(technician_id)
    for technician_id in cleaned:
        if not db.query(Technician).filter_by(technician_id=technician_id).first():
            raise HTTPException(404, f'Technician not found: {technician_id}')
    existing = {
        row.technician_id: row
        for row in db.query(WorkOrderAssignment).filter_by(work_order_id=work_order.work_order_id).all()
    }
    previous = current_assignees(db, work_order)
    now = datetime.utcnow()
    for technician_id, row in list(existing.items()):
        if technician_id not in cleaned:
            db.delete(row)
    added = []
    for technician_id in cleaned:
        row = existing.get(technician_id)
        if row is None:
            db.add(WorkOrderAssignment(
                work_order_id=work_order.work_order_id,
                technician_id=technician_id,
                response='Pending',
                assigned_at=now,
            ))
            if technician_id not in previous:
                added.append(technician_id)
        elif row.response in ('Rejected', 'Overdue'):
            row.response = 'Pending'
            row.assigned_at = now
            row.responded_at = None
            added.append(technician_id)
    work_order.assigned_technician_id = cleaned[0] if cleaned else None
    db.flush()
    db.expire(work_order, ['assignments'])
    removed = [technician_id for technician_id in previous if technician_id not in cleaned]
    return added, removed

def resolve_equipment(db, code=None, name=None):
    """Find a system machine by its number or by its exact name."""
    typed_code = (code or '').strip()
    typed_name = (name or '').strip()
    for raw in (typed_code, typed_name):
        if not raw:
            continue
        head = raw.split('—')[0].split(' - ')[0].strip()
        if head and head != raw:
            found = db.query(Equipment).filter(func.lower(Equipment.equipment_id) == head.lower()).first()
            if found:
                return found
    if typed_code:
        found = db.query(Equipment).filter(func.lower(Equipment.equipment_id) == typed_code.lower()).first()
        if found:
            return found
    label = typed_name or typed_code
    if not label:
        return None
    named = db.query(Equipment).filter(func.lower(Equipment.name) == label.lower()).all()
    return named[0] if len(named) == 1 else None

def attach_known_equipment(db, work_order):
    """Link the order to the system machine when the engineer wrote its name or its number."""
    equipment = resolve_equipment(db, work_order.equipment_id or work_order.manual_equipment_code, work_order.manual_equipment_name)
    if equipment is None and work_order.equipment_id:
        equipment = resolve_equipment(db, None, work_order.equipment_id)
    if equipment is None:
        return None, None
    if work_order.equipment_id != equipment.equipment_id:
        work_order.equipment_id = equipment.equipment_id
    line = db.query(PlantLine).filter_by(line_id=equipment.line_id).first() if equipment.line_id else None
    return equipment, line

def write_equipment_on_report(db, work_order, item, report):
    """Copy the machine number, name, plant, and line onto the daily-report row."""
    equipment, line = attach_known_equipment(db, work_order)
    if equipment is None or item is None:
        return
    item.equipment_id = equipment.equipment_id
    item.equipment_code = equipment.equipment_id
    item.equipment_name = equipment.name
    item.is_manual_entry = False
    if equipment.plant_id:
        item.plant_id = equipment.plant_id
        if report is not None and not report.plant_id:
            report.plant_id = equipment.plant_id
    if equipment.line_id:
        item.line_id = equipment.line_id
    if line is not None and line.line_number is not None:
        item.entered_line_number = str(line.line_number)

def deliver_to_technician(db, actor, work_order, technician_id):
    """Copy the work order into one technician's own daily report."""
    today = date.today()
    report = db.query(DailyReport).filter(
        DailyReport.report_date == today,
        DailyReport.technician_id == technician_id,
        DailyReport.status.in_(('Draft', 'Returned')),
    ).order_by(DailyReport.id.desc()).first()
    if report is None:
        sequence = db.query(DailyReport).count() + 1
        report_id = f'DR-{today.year}-{sequence:05d}'
        while db.query(DailyReport).filter_by(report_id=report_id).first():
            sequence += 1
            report_id = f'DR-{today.year}-{sequence:05d}'
        report = DailyReport(report_id=report_id, report_date=today, technician_id=technician_id, status='Draft', work_order_id=work_order.work_order_id)
        db.add(report)
        db.flush()
    already = db.query(DailyReportItem).filter_by(report_id=report.id, wo_id=work_order.work_order_id).first()
    if already is not None:
        return
    equipment, line = attach_known_equipment(db, work_order)
    maintenance_type = work_order.work_order_type if work_order.work_order_type in MAINT_TYPES else 'Corrective'
    plant_id = equipment.plant_id if equipment else work_order.manual_plant_id
    if plant_id and not report.plant_id:
        report.plant_id = plant_id
    db.add(DailyReportItem(
        report_id=report.id,
        equipment_id=work_order.equipment_id or work_order.manual_equipment_code,
        equipment_code=work_order.equipment_id or work_order.manual_equipment_code,
        equipment_name=equipment.name if equipment else work_order.manual_equipment_name,
        plant_id=plant_id,
        line_id=equipment.line_id if equipment else work_order.manual_line_id,
        entered_line_number=str(line.line_number) if line and line.line_number is not None else None,
        is_manual_entry=equipment is None,
        maintenance_type=maintenance_type,
        failure_reason=work_order.problem_description or work_order.failure_cause,
        action_taken=work_order.corrective_action or work_order.work_description,
        maintenance_start=None,
        maintenance_end=None,
        wo_id=work_order.work_order_id,
        pm_id=work_order.pm_id,
        maintenance_completed=False,
    ))
    db.flush()
    saved = db.query(DailyReportItem).filter_by(report_id=report.id, wo_id=work_order.work_order_id).first()
    write_equipment_on_report(db, work_order, saved, report)
    if report.equipment_id is None:
        report.equipment_id = work_order.equipment_id or work_order.manual_equipment_code
    if report.finding is None:
        report.finding = work_order.problem_description
    audit(db, actor, 'ASSIGN', 'DailyReport', report.report_id, new={'work_order_id': work_order.work_order_id, 'technician_id': technician_id})
    account = db.query(User).filter(User.technician_id == technician_id, User.is_active == True).first()
    if account:
        notify(db, account.id, 'Work Order Assigned', f'{work_order.work_order_id} was added to your daily report. Enter the repair actions.', 'work_order', work_order.work_order_id)

def retract_assignment(db, work_order, technician_id):
    """Remove the work order from a technician's open report when they are unselected."""
    reports = db.query(DailyReport).filter(
        DailyReport.technician_id == technician_id,
        DailyReport.status.in_(('Draft', 'Returned')),
    ).all()
    for report in reports:
        item = db.query(DailyReportItem).filter_by(report_id=report.id, wo_id=work_order.work_order_id).first()
        if item:
            db.delete(item)
        if report.work_order_id == work_order.work_order_id:
            report.work_order_id = None

def refresh_work_order_response(db, work_order):
    """Overdue only when every assignee has rejected or let the 24 hours pass."""
    rows = db.query(WorkOrderAssignment).filter_by(work_order_id=work_order.work_order_id).all()
    if any(row.response == 'Accepted' for row in rows):
        if work_order.status == 'Overdue':
            work_order.status = 'In Progress'
        return
    if rows and all(row.response in ('Rejected', 'Overdue') for row in rows):
        if work_order.status not in ('Closed', 'Completed', 'Cancelled'):
            work_order.status = 'Overdue'
    elif work_order.status == 'Overdue' and any(row.response == 'Pending' for row in rows):
        work_order.status = 'Open'

def expire_pending_assignments(db):
    cutoff = datetime.utcnow() - timedelta(hours=24)
    rows = db.query(WorkOrderAssignment).filter(
        WorkOrderAssignment.response == 'Pending',
        WorkOrderAssignment.assigned_at.isnot(None),
        WorkOrderAssignment.assigned_at <= cutoff,
    ).all()
    if not rows:
        return
    touched = set()
    now = datetime.utcnow()
    for row in rows:
        row.response = 'Overdue'
        row.responded_at = now
        touched.add(row.work_order_id)
    for work_order_id in touched:
        order = db.query(WorkOrder).filter_by(work_order_id=work_order_id).first()
        if order:
            refresh_work_order_response(db, order)
    db.commit()

def release_other_technicians(db, work_order, technician_id):
    """The technician who accepts owns the order. Remove it from every other technician."""
    rows = db.query(WorkOrderAssignment).filter_by(work_order_id=work_order.work_order_id).all()
    if any(row.response == 'Accepted' and row.technician_id != technician_id for row in rows):
        raise HTTPException(409, 'Another technician already accepted this work order')
    for row in rows:
        if row.technician_id == technician_id:
            continue
        retract_assignment(db, work_order, row.technician_id)
        account = db.query(User).filter(User.technician_id == row.technician_id, User.is_active == True).first()
        if account:
            notify(db, account.id, 'Work Order Accepted', f'{work_order.work_order_id} was accepted by another technician and removed from your account.', 'work_order', work_order.work_order_id)
        db.delete(row)
    if work_order.assigned_technician_id and work_order.assigned_technician_id != technician_id:
        retract_assignment(db, work_order, work_order.assigned_technician_id)
    work_order.assigned_technician_id = technician_id

def commit_accepted_work(db, actor, work_order, technician_id):
    """Write the accepted order into the technician report and the shared records."""
    deliver_to_technician(db, actor, work_order, technician_id)
    if not work_order.records_committed:
        consume_annual_plan(db, work_order, date.today())
        record_high_machine(db, work_order, technician_id)
        work_order.records_committed = True
    if work_order.status in ('Open', 'Overdue'):
        work_order.status = 'In Progress'

def apply_assignment(db, actor, work_order, technician_ids, had_assignees):
    added, removed = replace_assignees(db, work_order, technician_ids)
    for technician_id in removed:
        retract_assignment(db, work_order, technician_id)
    for technician_id in added:
        account = db.query(User).filter(User.technician_id == technician_id, User.is_active == True).first()
        if account:
            notify(db, account.id, 'Work Order Assigned', f'{work_order.work_order_id} is waiting for your acceptance. It becomes overdue if it is not accepted within 24 hours.', 'work_order', work_order.work_order_id)
    refresh_work_order_response(db, work_order)
    return added

def requested_assignees(data, payload):
    if 'assigned_technician_ids' in payload:
        payload.pop('assigned_technician_id', None)
        return payload.pop('assigned_technician_ids') or []
    if 'assigned_technician_id' in payload:
        single = payload.pop('assigned_technician_id')
        return [single] if single else []
    if getattr(data, 'assigned_technician_ids', None):
        return list(data.assigned_technician_ids)
    if getattr(data, 'assigned_technician_id', None):
        return [data.assigned_technician_id]
    return None

@app.post('/work-orders',response_model=WOOut)
def create_work_order(data:WOCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    payload = data.model_dump(exclude={'work_order_id', 'assigned_technician_ids', 'assigned_technician_id'})
    equipment = resolve_equipment(db, data.equipment_id or data.manual_equipment_code, data.manual_equipment_name)
    if equipment is None and data.equipment_id:
        equipment = resolve_equipment(db, None, data.equipment_id)
    if equipment:
        payload['equipment_id'] = equipment.equipment_id
        payload['manual_equipment_code'] = None
        payload['manual_equipment_name'] = None
        payload['manual_plant_id'] = None
        payload['manual_line_id'] = None
    elif not payload.get('equipment_id') and not payload.get('manual_equipment_code'):
        raise HTTPException(400, 'This equipment was not found. Enter its name or number as saved in the system.')
    elif payload.get('equipment_id') and not db.query(Equipment).filter_by(equipment_id=payload['equipment_id']).first():
        raise HTTPException(404, 'Equipment not found')
    wid=data.work_order_id or f'WO-{date.today().year}-{db.query(WorkOrder).count()+1:05d}'
    if db.query(WorkOrder).filter_by(work_order_id=wid).first(): raise HTTPException(409,'Work Order ID exists')
    o=WorkOrder(work_order_id=wid,created_by=u.username,**payload); db.add(o); db.flush()
    ids = list(data.assigned_technician_ids or [])
    if not ids and data.assigned_technician_id:
        ids = [data.assigned_technician_id]
    if ids:
        apply_assignment(db, u, o, ids, had_assignees=False)
    audit(db,u,'CREATE','WorkOrder',wid,new=data.model_dump()); db.commit(); db.refresh(o); return o

@app.post('/work-orders/from-activity', response_model=WOOut)
def issue_activity_work_order(data: ActivityWorkOrderCreate, db: Session = Depends(get_db), u=Depends(auth)):
    if not is_technician_account(u) or not u.technician_id:
        raise HTTPException(403, 'Only a technician can register this work order from the daily report')
    if data.maintenance_type not in ('Corrective', 'Emergency'):
        raise HTTPException(400, 'A work order is registered automatically for Corrective or Emergency work')
    code = (data.equipment_code or '').strip()
    if not code:
        raise HTTPException(400, 'Equipment code is required')
    equipment = db.query(Equipment).filter(func.lower(Equipment.equipment_id) == code.lower()).first()
    report = db.query(DailyReport).filter(
        DailyReport.report_date == date.today(),
        DailyReport.technician_id == u.technician_id,
        DailyReport.status.in_(('Draft', 'Returned')),
    ).order_by(DailyReport.id.desc()).first()
    if report is None:
        report = DailyReport(report_id='UNSAVED', report_date=date.today(), technician_id=u.technician_id, status='Draft')
    item = ReportItemCreate(
        equipment_id=equipment.equipment_id if equipment else code,
        equipment_code=equipment.equipment_id if equipment else code,
        equipment_name=equipment.name if equipment else (data.equipment_name or '').strip(),
        plant_id=equipment.plant_id if equipment else data.plant_id,
        line_id=equipment.line_id if equipment else data.line_id,
        is_manual_entry=equipment is None,
        maintenance_type=data.maintenance_type,
        failure_reason=data.failure_reason,
        action_taken=data.action_taken,
    )
    if item.is_manual_entry and not item.equipment_name:
        raise HTTPException(400, 'Enter the equipment name before registering this work order')
    work_order = issue_technician_work_order(db, u, item, report)
    db.commit()
    db.refresh(work_order)
    return work_order

@app.post('/work-orders/{wo_id}/release-activity')
def release_activity_work_order(wo_id: str, db: Session = Depends(get_db), u=Depends(auth)):
    """Drop a work order that was opened from a daily-report line and is not saved on a report yet."""
    if not is_technician_account(u):
        raise HTTPException(403, 'Only a technician can release this work order')
    order = db.query(WorkOrder).filter_by(work_order_id=wo_id).first()
    if not order:
        return {'released': False}
    if db.query(DailyReportItem).filter_by(wo_id=wo_id).first():
        return {'released': False}
    if not order_born_from_daily_report(db, order):
        return {'released': False}
    holder = db.query(DailyReport).filter(
        DailyReport.technician_id == u.technician_id,
        DailyReport.status.in_(('Draft', 'Returned')),
    ).order_by(DailyReport.id.desc()).first()
    if holder is None:
        holder = DailyReport(report_id='UNSAVED', report_date=date.today(), technician_id=u.technician_id or '', status='Draft')
    retire_activity_work_order(db, u, holder, wo_id)
    db.commit()
    return {'released': True}

def daily_parts_from_job(text):
    lines = []
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line:
            continue
        pieces = [part.strip() for part in line.split('|')]
        if len(pieces) >= 3 and pieces[2].startswith('No:'):
            name = '' if pieces[1] == '—' else pieces[1]
            number = pieces[2][3:].strip()
            if number == '—':
                number = ''
            if name or number:
                lines.append(f"{name or 'Part'} | No: {number or '—'} | Qty: —")
        else:
            lines.append(line)
    return '\n'.join(lines) or None

def sync_job_to_daily_report(db, actor, work_order, technician_id):
    """Copy the fault, repair, and spare parts into the technician's daily report."""
    deliver_to_technician(db, actor, work_order, technician_id)
    db.flush()
    report = db.query(DailyReport).filter(
        DailyReport.technician_id == technician_id,
        DailyReport.report_date == date.today(),
        DailyReport.status.in_(('Draft', 'Returned')),
    ).order_by(DailyReport.id.desc()).first()
    if report is None:
        return
    item = db.query(DailyReportItem).filter_by(report_id=report.id, wo_id=work_order.work_order_id).first()
    if item is None:
        return
    write_equipment_on_report(db, work_order, item, report)
    item.failure_reason = work_order.problem_description or work_order.failure_cause or item.failure_reason
    item.action_taken = work_order.corrective_action or work_order.work_description or item.action_taken
    item.maintenance_completed = True
    if item.action_taken:
        work_order.work_description = item.action_taken
        work_order.corrective_action = item.action_taken
    parts = daily_parts_from_job(work_order.parts_used)
    if not parts:
        return
    item.spare_parts = parts
    rows = db.query(DailyReportItem).filter_by(report_id=report.id).order_by(DailyReportItem.id).all()
    holder = next((row for row in rows if row.spare_parts), item)
    current = holder.spare_parts or ''
    extra = [line for line in parts.split('\n') if line and line not in current]
    if extra:
        holder.spare_parts = ('\n'.join(extra) if not current else current + '\n' + '\n'.join(extra)).strip()
    if holder is not item:
        item.spare_parts = holder.spare_parts

def accept_saved_job(db, actor, work_order):
    """Saving the job form accepts it for this technician and drops the other assignees."""
    technician_id = actor.technician_id
    row = db.query(WorkOrderAssignment).filter_by(
        work_order_id=work_order.work_order_id,
        technician_id=technician_id,
    ).first()
    if row is None:
        row = WorkOrderAssignment(
            work_order_id=work_order.work_order_id,
            technician_id=technician_id,
            response='Pending',
            assigned_at=datetime.utcnow(),
        )
        db.add(row)
        db.flush()
    if row.response == 'Rejected':
        raise HTTPException(409, 'This work order was already rejected')
    if row.response != 'Accepted':
        release_other_technicians(db, work_order, technician_id)
        row.response = 'Accepted'
        row.responded_at = datetime.utcnow()
        commit_accepted_work(db, actor, work_order, technician_id)
        refresh_work_order_response(db, work_order)
    else:
        release_other_technicians(db, work_order, technician_id)
        work_order.assigned_technician_id = technician_id
    sync_job_to_daily_report(db, actor, work_order, technician_id)

@app.put('/work-orders/{wo_id}',response_model=WOOut)
def update_work_order(wo_id:str,data:WOUpdate,db:Session=Depends(get_db),u=Depends(auth)):
    o=db.query(WorkOrder).filter_by(work_order_id=wo_id).first()
    if not o: raise HTTPException(404,'Work Order not found')
    if is_technician_account(u) and u.technician_id not in current_assignees(db, o):
        raise HTTPException(403, 'This work order is not assigned to you')
    payload=data.model_dump(exclude_unset=True)
    if is_technician_account(u):
        allowed={'status','start_time','end_time','downtime_h','labor_hours','failure_mode','failure_cause','corrective_action','result','verification','parts_used','closing_date'}
        if set(payload)-allowed: raise HTTPException(403,'Technician cannot modify this field')
        if payload.get('status')=='Closed': raise HTTPException(403,'Technician cannot close Work Order')
    elif u.role not in ENGINEER: raise HTTPException(403,'Read only account')
    had_assignees = bool(current_assignees(db, o))
    wanted = None
    if 'assigned_technician_ids' in payload or 'assigned_technician_id' in payload:
        wanted = requested_assignees(data, payload)
    old={k:getattr(o,k) for k in payload if hasattr(o,k)}
    for k,v in payload.items(): setattr(o,k,v)
    if o.status=='Closed': o.closed_by=u.username; o.closing_date=datetime.utcnow()
    if wanted is not None:
        apply_assignment(db, u, o, wanted, had_assignees)
    if is_technician_account(u):
        accept_saved_job(db, u, o)
    audit(db,u,'UPDATE','WorkOrder',wo_id,old=old,new=data.model_dump(exclude_unset=True)); db.commit(); db.refresh(o); return o

@app.post('/work-orders/{wo_id}/respond', response_model=WOOut)
def respond_work_order(wo_id: str, data: WORespond, db: Session = Depends(get_db), u=Depends(auth)):
    if not is_technician_account(u) or not u.technician_id:
        raise HTTPException(403, 'Only the assigned technician can accept or reject this work order')
    expire_pending_assignments(db)
    order = db.query(WorkOrder).filter_by(work_order_id=wo_id).first()
    if not order:
        raise HTTPException(404, 'Work Order not found')
    if u.technician_id not in current_assignees(db, order):
        raise HTTPException(403, 'This work order is not assigned to you')
    decision = (data.decision or '').strip()
    if decision not in ('Accepted', 'Rejected'):
        raise HTTPException(400, 'Decision must be Accepted or Rejected')
    row = db.query(WorkOrderAssignment).filter_by(work_order_id=order.work_order_id, technician_id=u.technician_id).first()
    if row is None:
        row = WorkOrderAssignment(work_order_id=order.work_order_id, technician_id=u.technician_id, response='Pending', assigned_at=datetime.utcnow())
        db.add(row)
        db.flush()
    if row.response != 'Pending':
        raise HTTPException(409, f'This work order is already {row.response}')
    row.response = decision
    row.responded_at = datetime.utcnow()
    if decision == 'Accepted':
        release_other_technicians(db, order, u.technician_id)
        commit_accepted_work(db, u, order, u.technician_id)
    refresh_work_order_response(db, order)
    audit(db, u, decision.upper(), 'WorkOrder', wo_id, new={'technician_id': u.technician_id, 'decision': decision})
    db.commit()
    db.refresh(order)
    return order

# Matching rules approved by project
# PM: same PM ID, open/non-closed WO.
# Corrective: equipment + corrective + failure/problem similarity among open WOs.
AUTO_WORK_ORDER_TYPES = {'Preventive', 'Corrective'}

def corrective_matches(db,item):
    equipment_filter = (
        WorkOrder.manual_equipment_code == item.equipment_code
        if item.is_manual_entry else WorkOrder.equipment_id == item.equipment_id
    )
    open_wos=db.query(WorkOrder).filter(equipment_filter,WorkOrder.work_order_type=='Corrective',WorkOrder.status.notin_(['Closed','Cancelled'])).all()
    text=(item.failure_reason or '').strip().lower()
    if not text:return open_wos
    exact=[w for w in open_wos if text in ((w.problem_description or '')+' '+(w.failure_cause or '')).lower()]
    return exact or open_wos


def ensure_preventive_pm(db, u, item, report):
    """Return the PM plan for a preventive report item.

    A preventive activity without a selected plan is an unplanned PM. It is
    retained in the annual PM schedule so future work can be planned instead
    of repeatedly treating the same activity as unplanned.
    """
    if item.pm_id:
        return db.query(PMPlan).filter_by(pm_id=item.pm_id).first()

    equipment_filter = (
        PMPlan.manual_equipment_code == item.equipment_code
        if item.is_manual_entry else PMPlan.equipment_id == item.equipment_id
    )
    pm = db.query(PMPlan).filter(
        equipment_filter,
        PMPlan.component_id == item.component_id,
        PMPlan.pm_type == 'Preventive',
        PMPlan.active == True,
    ).first()
    if pm:
        item.pm_id = pm.pm_id
        return pm

    sequence = db.query(PMPlan).filter(equipment_filter).count() + 1
    equipment_code = item.equipment_code or item.equipment_id
    pm_id = f'PM-{equipment_code}-{sequence:03d}'
    while db.query(PMPlan).filter_by(pm_id=pm_id).first():
        sequence += 1
        pm_id = f'PM-{equipment_code}-{sequence:03d}'

    pm = PMPlan(
        pm_id=pm_id,
        equipment_id=None if item.is_manual_entry else item.equipment_id,
        manual_equipment_code=equipment_code if item.is_manual_entry else None,
        manual_equipment_name=item.equipment_name if item.is_manual_entry else None,
        manual_plant_id=item.plant_id if item.is_manual_entry else None,
        manual_line_id=item.line_id if item.is_manual_entry else None,
        component_id=item.component_id,
        pm_type='Preventive',
        task=item.action_taken or 'Preventive maintenance recorded from Daily Report',
        frequency='Annual',
        frequency_value=1,
        last_pm_date=report.report_date,
        next_due_date=report.report_date + timedelta(days=365),
        active=True,
        added_unplanned=True,
        added_reason=f'Added from Daily Report {report.report_id}',
    )
    db.add(pm)
    db.flush()
    item.pm_id = pm.pm_id
    audit(
        db, u, 'AUTO_CREATE', 'PMPlan', pm_id,
        new={'source': 'Daily Report', 'report_id': report.report_id, 'unplanned': True},
    )
    return pm


def next_work_order_id(db, year):
    sequence = db.query(WorkOrder).count() + 1
    work_order_id = f'WO-{year}-{sequence:05d}'
    while db.query(WorkOrder).filter_by(work_order_id=work_order_id).first():
        sequence += 1
        work_order_id = f'WO-{year}-{sequence:05d}'
    return work_order_id

def issue_technician_work_order(db, actor, item, report):
    """Register a unique High work order for corrective or emergency work and write the related records."""
    work_order_id = next_work_order_id(db, report.report_date.year)
    now = datetime.utcnow()
    work_order = WorkOrder(
        work_order_id=work_order_id,
        work_order_type=item.maintenance_type,
        equipment_id=None if item.is_manual_entry else item.equipment_id,
        manual_equipment_code=item.equipment_code if item.is_manual_entry else None,
        manual_equipment_name=item.equipment_name if item.is_manual_entry else None,
        manual_plant_id=item.plant_id if item.is_manual_entry else None,
        manual_line_id=item.line_id if item.is_manual_entry else None,
        component_id=item.component_id,
        pm_id=item.pm_id,
        priority='High',
        status='In Progress',
        problem_description=item.failure_reason,
        work_description=item.action_taken,
        corrective_action=item.action_taken,
        planned_date=report.report_date,
        assigned_technician_id=report.technician_id,
        created_by='SYSTEM',
        records_committed=True,
    )
    if item.maintenance_start is not None:
        work_order.start_time = datetime.combine(report.report_date, item.maintenance_start)
    if item.maintenance_end is not None:
        work_order.end_time = datetime.combine(report.report_date, item.maintenance_end)
    if item.downtime_h is not None:
        work_order.downtime_h = item.downtime_h
    db.add(work_order)
    db.flush()
    db.add(WorkOrderAssignment(
        work_order_id=work_order_id,
        technician_id=report.technician_id,
        response='Accepted',
        assigned_at=now,
        responded_at=now,
    ))
    consume_annual_plan(db, work_order, report.report_date)
    record_high_machine(db, work_order, report.technician_id, item.action_taken)
    audit(db, actor, 'AUTO_CREATE', 'WorkOrder', work_order_id, new={'source': 'Daily Report', 'report_id': report.report_id, 'priority': 'High'})
    return work_order

def get_or_create_wo(db,u,item,report):
    # A report may be linked to an already-issued WO. It is linked but never
    # recreated, regardless of the maintenance type.
    if item.wo_id:
        w = db.query(WorkOrder).filter_by(work_order_id=item.wo_id).first()
        if not w:
            raise HTTPException(404, f'Work Order not found: {item.wo_id}')
        linked_equipment_code = (
            w.manual_equipment_code if item.is_manual_entry else w.equipment_id
        )
        expected_equipment_code = item.equipment_code if item.is_manual_entry else item.equipment_id
        if linked_equipment_code != expected_equipment_code:
            raise HTTPException(400, 'Work Order does not belong to this equipment')
        return w, 'linked'

    # A technician's corrective or emergency entry is a High work order with its own number.
    if item.maintenance_type in ('Corrective', 'Emergency'):
        return issue_technician_work_order(db, u, item, report), 'created'

    # Inspection, routine, and lubrication stay on the report without a new work order.
    if item.maintenance_type not in AUTO_WORK_ORDER_TYPES:
        return None, 'not_required'

    if item.maintenance_type=='Preventive':
        ensure_preventive_pm(db, u, item, report)
        w=db.query(WorkOrder).filter(WorkOrder.pm_id==item.pm_id,WorkOrder.status.notin_(['Closed','Cancelled'])).first()
        if w:return w,'matched'
    if item.maintenance_type=='Corrective':
        matches=corrective_matches(db,item)
        if len(matches)==1:return matches[0],'matched'
        if len(matches)>1:return None,'review'
    wid=f'WO-{report.report_date.year}-{db.query(WorkOrder).count()+1:05d}'
    w=WorkOrder(work_order_id=wid,work_order_type=item.maintenance_type,equipment_id=None if item.is_manual_entry else item.equipment_id,manual_equipment_code=item.equipment_code if item.is_manual_entry else None,manual_equipment_name=item.equipment_name if item.is_manual_entry else None,manual_plant_id=item.plant_id if item.is_manual_entry else None,manual_line_id=item.line_id if item.is_manual_entry else None,component_id=item.component_id,pm_id=item.pm_id,priority='Medium',status='Open',problem_description=item.failure_reason,work_description=item.action_taken,planned_date=report.report_date,created_by='SYSTEM')
    db.add(w); db.flush(); audit(db,u,'AUTO_CREATE','WorkOrder',wid,new={'source':'Daily Report','report_id':report.report_id})
    return w,'created'

REPORT_ORDER_TYPES = {'Corrective', 'Emergency'}

def order_born_from_daily_report(db, order):
    """True when this work order was opened because a daily-report line was corrective or emergency."""
    if not order or order.created_by != 'SYSTEM':
        return False
    rows = db.query(AuditTrail).filter(
        AuditTrail.entity == 'WorkOrder',
        AuditTrail.entity_id == order.work_order_id,
        AuditTrail.action == 'AUTO_CREATE',
    ).all()
    return any('Daily Report' in (row.new_value or '') for row in rows)

def retire_activity_work_order(db, user, report, order_id, new_type=None):
    """Remove a report-born work order once the activity no longer needs one."""
    if not order_id:
        return False
    if db.query(DailyReportItem).filter(DailyReportItem.wo_id == order_id).first():
        return False
    order = db.query(WorkOrder).filter_by(work_order_id=order_id).first()
    if not order or not order_born_from_daily_report(db, order):
        return False
    db.query(WorkOrderAssignment).filter_by(work_order_id=order_id).delete(synchronize_session=False)
    db.expire(order, ['assignments'])
    db.query(Measurement).filter_by(work_order_id=order_id).delete(synchronize_session=False)
    db.query(PartUsed).filter_by(work_order_id=order_id).delete(synchronize_session=False)
    db.query(AnnualPMDayTask).filter_by(work_order_id=order_id).update(
        {AnnualPMDayTask.work_order_id: None}, synchronize_session=False,
    )
    db.query(LubricationLine).filter_by(work_order_id=order_id).update(
        {LubricationLine.work_order_id: None}, synchronize_session=False,
    )
    db.query(DailyReport).filter(DailyReport.work_order_id == order_id).update(
        {DailyReport.work_order_id: None}, synchronize_session=False,
    )
    records = db.query(MachineRecord).filter_by(wo_id=order_id).all()
    for record in records:
        if record.daily_report_id:
            record.wo_id = None
            if new_type and record.daily_report_id == report.id:
                record.record_type = new_type
        else:
            db.delete(record)
    db.query(Notification).filter(
        Notification.kind == 'work_order',
        Notification.related_id == order_id,
    ).delete(synchronize_session=False)
    db.delete(order)
    audit(
        db, user, 'DELETE', 'WorkOrder', order_id,
        old={'report_id': report.report_id, 'reason': 'Maintenance type no longer requires a work order'},
    )
    return True

# ---------------------------------------------------------------------------
# Daily Report
# ---------------------------------------------------------------------------

def _time_to_hours(t: time | None) -> float | None:
    if t is None:
        return None
    return t.hour + t.minute / 60 + t.second / 3600


def calculate_downtime(start: time | None, end: time | None) -> float | None:
    """Return downtime in decimal hours. Supports an interval crossing midnight."""
    if start is None or end is None:
        return None
    start_h = _time_to_hours(start)
    end_h = _time_to_hours(end)
    if start_h is None or end_h is None:
        return None
    delta = end_h - start_h
    if delta < 0:
        delta += 24
    return round(delta, 4)

MAINT_TYPES = {
    "Preventive",
    "Corrective",
    "Routine",
    "Inspection",
    "Lubrication",
    "Emergency",
}

def propose_unknown_equipment(db, report, item):
    """Keep an unregistered machine out of the plant register until an engineer approves it."""
    if not item.is_manual_entry:
        return
    code = (item.equipment_code or item.equipment_id or '').strip()
    name = (item.equipment_name or '').strip()
    if not code or not name:
        return
    if db.query(Equipment).filter(func.lower(Equipment.equipment_id) == code.lower()).first():
        return
    existing = db.query(PendingEquipment).filter(
        func.lower(PendingEquipment.equipment_code) == code.lower(),
        PendingEquipment.plant_id == item.plant_id,
        PendingEquipment.status == 'Pending',
    ).first()
    if existing:
        existing.equipment_name = name
        existing.line_id = item.line_id
        existing.line_number = item.entered_line_number
        existing.report_id = report.report_id
        existing.technician_id = report.technician_id
        return
    db.add(PendingEquipment(
        equipment_code=code,
        equipment_name=name,
        plant_id=item.plant_id or report.plant_id,
        line_id=item.line_id,
        line_number=item.entered_line_number,
        report_id=report.report_id,
        technician_id=report.technician_id,
        status='Pending',
    ))
    for engineer in db.query(User).filter(User.role.in_(list(ENGINEER)), User.is_active == True).all():
        notify(db, engineer.id, 'معدات جديدة', f'{code} — {name} was reported and is waiting for approval.', 'pending_equipment', code)

def validate_report_item(db: Session, item: ReportItemCreate):
    if item.maintenance_type not in MAINT_TYPES:
        raise HTTPException(400, f'Invalid maintenance type: {item.maintenance_type}')

    equipment_code = (item.equipment_id or item.equipment_code or '').strip()
    if not equipment_code:
        raise HTTPException(400, 'Equipment code is required')
    eq = db.query(Equipment).filter(
        func.lower(Equipment.equipment_id) == equipment_code.lower()
    ).first()
    if eq:
        # Canonical data wins whenever the equipment is registered.
        item.equipment_id = eq.equipment_id
        item.equipment_code = eq.equipment_id
        item.equipment_name = eq.name
        item.plant_id = eq.plant_id
        item.line_id = eq.line_id
        item.is_manual_entry = False
    else:
        if not item.equipment_name or not item.equipment_name.strip():
            raise HTTPException(400, f'Equipment {equipment_code} is not registered; enter its name for a manual report entry')
        item.equipment_id = equipment_code
        item.equipment_code = equipment_code
        item.equipment_name = item.equipment_name.strip()
        item.is_manual_entry = True
        if item.component_id or item.pm_id:
            raise HTTPException(400, 'Manual equipment entries cannot reference a component or existing PM plan')

    if item.component_id:
        component = db.query(Component).filter_by(
            component_id=item.component_id,
            equipment_id=item.equipment_id
        ).first()
        if not component:
            raise HTTPException(404, f'Component not found for equipment: {item.component_id}')

    if item.pm_id:
        pm = db.query(PMPlan).filter_by(pm_id=item.pm_id).first()
        if not pm:
            raise HTTPException(404, f'PM not found: {item.pm_id}')

    # If downtime boundaries are supplied, the system owns the calculation.
    if item.downtime_start is not None and item.downtime_end is not None:
        item.downtime_h = calculate_downtime(
            item.downtime_start, item.downtime_end
        )
    elif item.downtime_h is not None and item.downtime_h < 0:
        raise HTTPException(400, 'Downtime cannot be negative')


def report_to_dict(r, items, db: Session):
    technician = db.query(Technician).filter_by(
        technician_id=r.technician_id
    ).first()
    report = {
        column.name: getattr(r, column.name)
        for column in r.__table__.columns
    }
    # A printed report identifies the person, never their user login or code.
    report['technician_code'] = r.technician_id
    report['technician_name'] = technician.name if technician else None
    report['technician_id'] = technician.name if technician else None
    return {
        'report': report,
        'items': items,
    }


@app.get('/daily-reports')
def list_reports(
    status: str | None = None,
    equipment_id: str | None = None,
    technician_id: str | None = None,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    q = db.query(DailyReport)
    if status:
        q = q.filter(DailyReport.status == status)
    if equipment_id:
        q = q.filter(DailyReport.equipment_id == equipment_id)

    # A technician sees his own reports. Engineers/developers can see all.
    if is_technician_account(u):
        q = q.filter(DailyReport.technician_id == u.technician_id)
    elif technician_id:
        q = q.filter(DailyReport.technician_id == technician_id)

    return q.order_by(
        DailyReport.report_date.desc(),
        DailyReport.id.desc()
    ).all()


@app.get('/daily-reports/{report_id}')
def get_report(
    report_id: str,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    r = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not r:
        raise HTTPException(404, 'Daily Report not found')

    if is_technician_account(u) and r.technician_id != u.technician_id:
        raise HTTPException(403, 'You can only view your own reports')

    items = db.query(DailyReportItem).filter_by(report_id=r.id).all()
    return report_to_dict(r, items, db)


@app.post('/daily-reports')
def create_report(
    data: DailyReportCreate,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    # Daily Report creation is a technician workflow.
    # Engineer/developer accounts can still create a report for controlled
    # administrative/testing purposes, but a technician can only create his own.
    if is_technician_account(u):
        if not u.technician_id:
            raise HTTPException(400, 'Your account is not linked to a technician')
        technician = provision_technician_profile(db, u)
        if not technician:
            raise HTTPException(400, 'Your account is not linked to a technician')
        technician_id = technician.technician_id
    else:
        # For non-technician users, an explicit technician is required.
        # This remains compatible with the existing schema if an admin client
        # still sends technician_id.
        technician_id = getattr(data, 'technician_id', None)
        if not technician_id:
            raise HTTPException(
                400,
                'technician_id is required for non-technician report creation'
            )

    technician = db.query(Technician).filter_by(technician_id=technician_id).first()
    if not technician:
        raise HTTPException(404, f'Technician not found: {technician_id}')

    if not data.items:
        raise HTTPException(400, 'Daily Report must contain at least one equipment item')

    # One daily report per technician/date.
    existing = db.query(DailyReport).filter(
        DailyReport.report_date == data.report_date,
        DailyReport.technician_id == technician_id,
        DailyReport.status != 'Returned',
    ).first()
    if existing:
        raise HTTPException(
            409,
            f'Daily Report already exists for this technician/date: {existing.report_id}'
        )

    rid = f'DR-{data.report_date.year}-{db.query(DailyReport).count()+1:05d}'

    r = DailyReport(
        report_id=rid,
        report_date=data.report_date,
        technician_id=technician_id,
        plant_id=data.plant_id,
        shift=data.shift,
        shift_engineer=data.shift_engineer,
        general_notes=data.general_notes,
        status='Draft',
    )
    db.add(r)
    db.flush()

    linked_wos = []
    machine_records = []

    for item in data.items:
        validate_report_item(db, item)

        payload = item.model_dump()

        # Always calculate downtime from start/end when both are present.
        if item.downtime_start is not None and item.downtime_end is not None:
            payload['downtime_h'] = calculate_downtime(
                item.downtime_start, item.downtime_end
            )

        row = DailyReportItem(report_id=r.id, **payload)
        db.add(row)
        db.flush()
        propose_unknown_equipment(db, r, row)

        # Automatic WO matching/creation.
        w, mode = get_or_create_wo(db, u, row, r)

        if w:
            row.wo_id = w.work_order_id
            linked_wos.append(w.work_order_id)

            # Keep WO data synchronized with the report's measured times.
            if row.maintenance_start is not None:
                # WorkOrder stores datetime; use report date + time.
                w.start_time = datetime.combine(
                    r.report_date, row.maintenance_start
                )
            if row.maintenance_end is not None:
                w.end_time = datetime.combine(
                    r.report_date, row.maintenance_end
                )
            if row.downtime_h is not None:
                w.downtime_h = row.downtime_h
            if row.action_taken:
                w.work_description = row.action_taken
                w.corrective_action = row.action_taken
            if row.spare_parts:
                w.parts_used = row.spare_parts
            if not current_assignees(db, w):
                w.assigned_technician_id = technician_id
                db.add(WorkOrderAssignment(work_order_id=w.work_order_id, technician_id=technician_id))

            if w.pm_id is None and row.pm_id:
                w.pm_id = row.pm_id

        elif mode == 'review':
            notify(
                db,
                None,
                'Corrective WO Matching Review',
                f'{rid}: multiple open corrective WOs match {row.equipment_id}; Engineer review required',
                'wo_match',
                rid,
            )

        # The machine log keeps corrective and emergency work only. Oil changes are recorded from the lubrication report.
        if row.maintenance_type in ('Corrective', 'Emergency') and not (row.wo_id and db.query(MachineRecord).filter_by(wo_id=row.wo_id).first()):
            machine_record = MachineRecord(
                equipment_id=row.equipment_id,
                record_date=r.report_date,
                record_type=row.maintenance_type,
                daily_report_id=r.id,
                wo_id=row.wo_id,
                pm_id=row.pm_id,
                technician_id=r.technician_id,
                description=row.action_taken,
                cause=row.failure_reason,
                action=row.action_taken,
                start_time=row.maintenance_start,
                end_time=row.maintenance_end,
                downtime_h=row.downtime_h,
                spare_parts=row.spare_parts,
            )
            db.add(machine_record)
            machine_records.append(machine_record)

        # The equipment was mentioned in the daily report, so its machine
        # record is created automatically. Equipment status is updated only
        # when actual maintenance is being performed.
        eq = db.query(Equipment).filter_by(
            equipment_id=row.equipment_id
        ).first()
        if eq:
            if row.maintenance_type in ('Corrective', 'Preventive'):
                eq.status = 'Under Maintenance'

    # Populate report-level fields from its first item for compatibility.
    first = data.items[0]
    r.equipment_id = first.equipment_id
    r.work_summary = first.action_taken
    r.finding = first.failure_reason
    r.action_taken = first.action_taken
    r.general_notes = data.general_notes
    r.labor_hours = None

    audit(
        db,
        u,
        'CREATE',
        'DailyReport',
        rid,
        new={
            'date': str(data.report_date),
            'technician_id': technician_id,
            'items': len(data.items),
            'work_orders': linked_wos,
        },
    )

    db.commit()
    db.refresh(r)

    return get_report(rid, db, u)


@app.put('/daily-reports/{report_id}')
def update_report(
    report_id: str,
    data: DailyReportUpdate,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    r = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not r:
        raise HTTPException(404, 'Daily Report not found')

    if r.locked_at:
        raise HTTPException(409, 'Approved report is locked')

    if r.status not in ('Draft', 'Returned'):
        raise HTTPException(
            409,
            f'Report cannot be edited while status is {r.status}'
        )

    if is_technician_account(u) and r.technician_id != u.technician_id:
        raise HTTPException(403, 'You can only edit your own reports')

    old = {
        'report_date': r.report_date,
        'shift': r.shift,
        'shift_engineer': r.shift_engineer,
    }

    header_locked = is_technician_account(u) and r.status == 'Returned'
    if not header_locked:
        if data.report_date is not None:
            r.report_date = data.report_date
        if data.shift is not None:
            r.shift = data.shift
        if data.shift_engineer is not None:
            r.shift_engineer = data.shift_engineer
        if data.general_notes is not None:
            r.general_notes = data.general_notes
        if data.plant_id is not None:
            r.plant_id = data.plant_id

    if data.items is not None:
        if not data.items:
            raise HTTPException(400, 'Daily Report must contain at least one item')

        # For the first implementation, rebuild item rows while the report is
        # still Draft/Returned. This keeps the API deterministic and avoids
        # duplicate Machine Records/WO links.
        assigned_rows = {}
        kept_parts = None
        existing_items = db.query(DailyReportItem).filter_by(report_id=r.id).all()
        previous_order_ids = {row.wo_id for row in existing_items if row.wo_id}
        equipment_by_order = {row.wo_id: row.equipment_id for row in existing_items if row.wo_id}
        if header_locked:
            sample = next((row for row in existing_items if row.spare_parts), None)
            kept_parts = sample.spare_parts if sample else None
        if is_technician_account(u):
            for existing in existing_items:
                if existing.wo_id:
                    assigned_rows[existing.wo_id] = {
                        column.name: getattr(existing, column.name)
                        for column in existing.__table__.columns
                        if column.name != 'id'
                    }
        for existing in existing_items:
            db.expunge(existing)
        db.query(DailyReportItem).filter(
            DailyReportItem.report_id == r.id
        ).delete(synchronize_session=False)
        db.flush()

        saved_rows = []
        for item in data.items:
            validate_report_item(db, item)
            payload = item.model_dump()
            if item.downtime_start is not None and item.downtime_end is not None:
                payload['downtime_h'] = calculate_downtime(
                    item.downtime_start, item.downtime_end
                )
            locked = assigned_rows.get(payload.get('wo_id'))
            if locked:
                chosen = {
                    'action_taken': payload.get('action_taken'),
                    'maintenance_type': payload.get('maintenance_type') or locked.get('maintenance_type'),
                    'maintenance_start': payload.get('maintenance_start'),
                    'maintenance_end': payload.get('maintenance_end'),
                    'downtime_start': payload.get('downtime_start'),
                    'downtime_end': payload.get('downtime_end'),
                    'downtime_h': payload.get('downtime_h'),
                    'spare_parts': payload.get('spare_parts'),
                }
                payload = dict(locked)
                payload.update(chosen)
            if header_locked:
                payload['spare_parts'] = kept_parts
            if payload.get('maintenance_type') not in REPORT_ORDER_TYPES:
                payload['wo_id'] = None
            payload.pop('report_id', None)
            row = DailyReportItem(report_id=r.id, **payload)
            db.add(row)
            db.flush()
            saved_rows.append(row)
            propose_unknown_equipment(db, r, row)
            if not row.wo_id and row.maintenance_type in ('Corrective', 'Emergency'):
                created, _mode = get_or_create_wo(db, u, row, r)
                if created:
                    row.wo_id = created.work_order_id
            if row.wo_id:
                order = db.query(WorkOrder).filter_by(work_order_id=row.wo_id).first()
                if order:
                    if row.action_taken:
                        order.corrective_action = row.action_taken
                        record_high_machine(db, order, r.technician_id, row.action_taken)
                    if row.maintenance_start is not None:
                        order.start_time = datetime.combine(r.report_date, row.maintenance_start)
                    if row.maintenance_end is not None:
                        order.end_time = datetime.combine(r.report_date, row.maintenance_end)
                    if row.downtime_h is not None:
                        order.downtime_h = row.downtime_h
                    if order.created_by == 'SYSTEM' and order.work_order_type != row.maintenance_type:
                        order.work_order_type = row.maintenance_type

        kept_ids = {row.wo_id for row in saved_rows if row.wo_id}
        for order_id in previous_order_ids - kept_ids:
            successor = next((
                row for row in saved_rows
                if not row.wo_id and row.equipment_id == equipment_by_order.get(order_id)
            ), None)
            retire_activity_work_order(
                db, u, r, order_id,
                successor.maintenance_type if successor else None,
            )

        first = data.items[0]
        r.equipment_id = first.equipment_id
        r.work_summary = first.action_taken
        r.finding = first.failure_reason
        r.action_taken = first.action_taken

    audit(
        db,
        u,
        'UPDATE',
        'DailyReport',
        report_id,
        old=old,
        new=data.model_dump(exclude_unset=True),
    )
    db.commit()
    db.refresh(r)
    return get_report(report_id, db, u)


def assert_daily_send_window(db: Session, technician_id: str, report_id: str | None = None):
    """A technician sends one report, then waits 24 hours for the next one."""
    latest = db.query(DailyReport).filter(
        DailyReport.technician_id == technician_id,
        DailyReport.submitted_at.isnot(None),
        DailyReport.status.in_(['Submitted', 'Approved']),
    ).order_by(DailyReport.submitted_at.desc()).first()
    if not latest or not latest.submitted_at:
        return
    if report_id and latest.report_id == report_id:
        return
    if datetime.utcnow() < latest.submitted_at + timedelta(hours=24):
        raise HTTPException(
            409,
            'You can send one report a day. A new report opens 24 hours after the last one was sent.',
        )


@app.post('/daily-reports/{report_id}/submit')
def submit_report(
    report_id: str,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    r = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not r:
        raise HTTPException(404, 'Daily Report not found')

    if is_technician_account(u) and r.technician_id != u.technician_id:
        raise HTTPException(403, 'You can only submit your own report')

    if r.locked_at:
        raise HTTPException(409, 'Report is locked')

    if r.status not in ('Draft', 'Returned'):
        raise HTTPException(
            409,
            f'Report cannot be submitted from status {r.status}'
        )

    if is_technician_account(u):
        assert_daily_send_window(db, r.technician_id, r.report_id)

    items = db.query(DailyReportItem).filter_by(report_id=r.id).all()
    if not items:
        raise HTTPException(400, 'Cannot submit an empty Daily Report')

    # Registered equipment must exist. Manual entries are valid because a
    # technician is allowed to report equipment not registered in the CMMS.
    for item in items:
        if item.wo_id and (not item.action_taken or item.maintenance_start is None or item.maintenance_end is None):
            raise HTTPException(400, 'Enter the repair actions and the repair start and end time for each accepted work order')
        if item.is_manual_entry:
            continue
        if not db.query(Equipment).filter_by(
            equipment_id=item.equipment_id
        ).first():
            raise HTTPException(
                400,
                f'Equipment not found: {item.equipment_id}'
            )

    r.status = 'Submitted'
    r.submitted_at = datetime.utcnow()
    r.return_reason = None
    r.returned_at = None

    for eng in db.query(User).filter(
        User.role.in_(list(ENGINEER)),
        User.is_active == True,
    ).all():
        notify(
            db,
            eng.id,
            'Daily Report Submitted',
            f'{r.report_id} requires engineer review',
            'daily_report',
            r.report_id,
        )

    audit(db, u, 'SUBMIT', 'DailyReport', report_id)
    db.commit()
    db.refresh(r)
    return r


def complete_work_orders_on_report(db, report, user, now):
    """An approved daily report completes every work order written on it."""
    items = db.query(DailyReportItem).filter(
        DailyReportItem.report_id == report.id,
        DailyReportItem.wo_id.isnot(None),
    ).all()
    completed = []
    seen = set()
    for item in items:
        if not item.wo_id or item.wo_id in seen:
            continue
        seen.add(item.wo_id)
        order = db.query(WorkOrder).filter_by(work_order_id=item.wo_id).first()
        if not order or order.status in ('Completed', 'Cancelled'):
            continue
        previous = order.status
        order.status = 'Completed'
        if not order.closed_by:
            order.closed_by = user.username if user else 'SYSTEM'
        if not order.closing_date:
            order.closing_date = now
        audit(
            db, user, 'COMPLETE', 'WorkOrder', order.work_order_id,
            old={'status': previous},
            new={'status': 'Completed', 'report_id': report.report_id},
        )
        completed.append(order.work_order_id)
    return completed


@app.post('/daily-reports/{report_id}/approve')
def approve_report(
    report_id: str,
    db: Session = Depends(get_db),
    u=Depends(role(*ENGINEER)),
):
    r = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not r:
        raise HTTPException(404, 'Daily Report not found')

    if r.locked_at:
        raise HTTPException(409, 'Approved report is already locked')

    if r.status != 'Submitted':
        raise HTTPException(
            409,
            f'Only Submitted reports can be approved; current status: {r.status}'
        )

    now = datetime.utcnow()
    r.status = 'Approved'
    r.approved_at = now
    r.approved_by = u.full_name
    r.locked_at = now
    completed_orders = complete_work_orders_on_report(db, r, u, now)

    audit(
        db,
        u,
        'APPROVE',
        'DailyReport',
        report_id,
        new={
            'approved_by': u.full_name,
            'approved_at': str(now),
            'print_ready': True,
        },
    )

    # Notify the report technician.
    if r.technician_id:
        tech_user = db.query(User).filter(
            User.technician_id == r.technician_id,
            User.is_active == True,
        ).first()
        if tech_user:
            notify(
                db,
                tech_user.id,
                'Daily Report Approved',
                f'{r.report_id} was approved by {u.full_name}',
                'daily_report_approved',
                r.report_id,
            )

    db.commit()
    db.refresh(r)

    return {
        'report_id': r.report_id,
        'status': r.status,
        'approved_by': r.approved_by,
        'approved_at': r.approved_at,
        'locked_at': r.locked_at,
        'print_ready': True,
        'completed_work_orders': completed_orders,
    }


@app.post('/daily-reports/{report_id}/return')
def return_report(
    report_id: str,
    reason: str = '',
    db: Session = Depends(get_db),
    u=Depends(role(*ENGINEER)),
):
    r = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not r:
        raise HTTPException(404, 'Daily Report not found')

    if r.locked_at:
        raise HTTPException(409, 'Approved report cannot be returned')

    if r.status != 'Submitted':
        raise HTTPException(
            409,
            f'Only Submitted reports can be returned; current status: {r.status}'
        )

    reason = (reason or '').strip()
    if not reason:
        raise HTTPException(400, 'Enter the reason for rejecting this report.')

    r.status = 'Returned'
    r.return_reason = reason
    r.returned_at = datetime.utcnow()

    audit(
        db,
        u,
        'RETURN',
        'DailyReport',
        report_id,
        new={'reason': reason},
    )

    if r.technician_id:
        tech_user = db.query(User).filter(
            User.technician_id == r.technician_id,
            User.is_active == True,
        ).first()
        if tech_user:
            notify(
                db,
                tech_user.id,
                'Daily Report Returned',
                f'{r.report_id} was returned by {u.full_name}. Reason: {reason}',
                'daily_report_returned',
                r.report_id,
            )

    db.commit()
    db.refresh(r)
    return r

def remove_work_order(db, order):
    order_id = order.work_order_id
    db.query(WorkOrderAssignment).filter_by(work_order_id=order_id).delete(synchronize_session=False)
    db.expire(order, ['assignments'])
    db.query(Measurement).filter_by(work_order_id=order_id).delete(synchronize_session=False)
    db.query(PartUsed).filter_by(work_order_id=order_id).delete(synchronize_session=False)
    db.query(AnnualPMDayTask).filter_by(work_order_id=order_id).update(
        {AnnualPMDayTask.work_order_id: None}, synchronize_session=False,
    )
    db.query(LubricationLine).filter_by(work_order_id=order_id).update(
        {LubricationLine.work_order_id: None}, synchronize_session=False,
    )
    db.query(DailyReport).filter(DailyReport.work_order_id == order_id).update(
        {DailyReport.work_order_id: None}, synchronize_session=False,
    )
    db.query(DailyReportItem).filter(DailyReportItem.wo_id == order_id).update(
        {DailyReportItem.wo_id: None}, synchronize_session=False,
    )
    db.query(MachineRecord).filter_by(wo_id=order_id).delete(synchronize_session=False)
    db.query(Notification).filter(Notification.related_id == order_id).delete(synchronize_session=False)
    db.delete(order)


def purge_kpi_history(db, equipment_ids=None, plant_id=None, line_ids=None):
    """Remove the records that still draw a deleted plant or machine on the KPI charts."""
    equipment_ids = [value for value in (equipment_ids or []) if value]
    line_ids = [value for value in (line_ids or []) if value]
    order_filters = []
    if equipment_ids:
        order_filters.append(WorkOrder.equipment_id.in_(equipment_ids))
        order_filters.append(WorkOrder.manual_equipment_code.in_(equipment_ids))
    if plant_id:
        order_filters.append(WorkOrder.manual_plant_id == plant_id)
    if line_ids:
        order_filters.append(WorkOrder.manual_line_id.in_(line_ids))
    if order_filters:
        for order in db.query(WorkOrder).filter(or_(*order_filters)).all():
            remove_work_order(db, order)
    if equipment_ids:
        db.query(MachineRecord).filter(MachineRecord.equipment_id.in_(equipment_ids)).delete(synchronize_session=False)
    if plant_id:
        reports = db.query(DailyReport).filter(DailyReport.plant_id == plant_id).all()
        report_ids = [row.id for row in reports]
        if report_ids:
            db.query(DailyReportItem).filter(DailyReportItem.report_id.in_(report_ids)).delete(synchronize_session=False)
            db.query(MachineRecord).filter(MachineRecord.daily_report_id.in_(report_ids)).delete(synchronize_session=False)
            for row in reports:
                db.delete(row)
    item_filters = []
    if equipment_ids:
        item_filters.append(DailyReportItem.equipment_id.in_(equipment_ids))
        item_filters.append(DailyReportItem.equipment_code.in_(equipment_ids))
    if plant_id:
        item_filters.append(DailyReportItem.plant_id == plant_id)
    if line_ids:
        item_filters.append(DailyReportItem.line_id.in_(line_ids))
    if item_filters:
        db.query(DailyReportItem).filter(or_(*item_filters)).delete(synchronize_session=False)
    plan_filters = []
    if equipment_ids:
        plan_filters.append(PMPlan.equipment_id.in_(equipment_ids))
        plan_filters.append(PMPlan.manual_equipment_code.in_(equipment_ids))
    if plant_id:
        plan_filters.append(PMPlan.manual_plant_id == plant_id)
    if line_ids:
        plan_filters.append(PMPlan.manual_line_id.in_(line_ids))
    if plan_filters:
        db.query(PMPlan).filter(or_(*plan_filters)).delete(synchronize_session=False)
    if equipment_ids:
        db.query(Component).filter(Component.equipment_id.in_(equipment_ids)).delete(synchronize_session=False)
        db.query(SOP).filter(SOP.equipment_id.in_(equipment_ids)).delete(synchronize_session=False)
        db.query(Measurement).filter(Measurement.equipment_id.in_(equipment_ids)).delete(synchronize_session=False)
        db.query(PartUsed).filter(PartUsed.equipment_id.in_(equipment_ids)).delete(synchronize_session=False)
        db.query(MotorConditionReading).filter(or_(
            MotorConditionReading.equipment_id.in_(equipment_ids),
            MotorConditionReading.machine.in_(equipment_ids),
        )).delete(synchronize_session=False)
    target_filters = []
    if equipment_ids:
        target_filters.append(KpiTarget.equipment_id.in_(equipment_ids))
    if plant_id:
        target_filters.append(KpiTarget.plant_id == plant_id)
    if line_ids:
        target_filters.append(KpiTarget.line_id.in_(line_ids))
    if target_filters:
        db.query(KpiTarget).filter(or_(*target_filters)).delete(synchronize_session=False)


@app.delete('/plants/{plant_id}')
def delete_plant(plant_id: str, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    plant = db.query(Plant).filter_by(plant_id=plant_id).first()
    if not plant:
        raise HTTPException(404, 'Plant not found')
    plans = db.query(AnnualPMPlan).filter_by(plant_id=plant_id).all()
    plan_ids = [plan.id for plan in plans]
    if plan_ids:
        db.query(AnnualPMDayTask).filter(AnnualPMDayTask.plan_id.in_(plan_ids)).delete(synchronize_session=False)
        db.query(AnnualPMItem).filter(AnnualPMItem.plan_id.in_(plan_ids)).delete(synchronize_session=False)
        db.query(AnnualPMPlan).filter(AnnualPMPlan.id.in_(plan_ids)).delete(synchronize_session=False)
    line_ids = [row.line_id for row in db.query(PlantLine).filter_by(plant_id=plant_id).all()]
    equipment_ids = [
        row.equipment_id for row in db.query(Equipment).filter(Equipment.plant_id == plant_id).all()
    ]
    purge_kpi_history(db, equipment_ids, plant_id, line_ids)
    db.flush()
    if equipment_ids:
        db.query(Equipment).filter(Equipment.equipment_id.in_(equipment_ids)).delete(synchronize_session=False)
    db.query(PlantLine).filter_by(plant_id=plant_id).delete(synchronize_session=False)
    db.delete(plant)
    audit(db, u, 'DELETE', 'Plant', plant_id)
    db.commit()
    return {'ok': True}


@app.delete('/lines/{line_id}')
def delete_line(line_id: str, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    line = db.query(PlantLine).filter_by(line_id=line_id).first()
    if not line:
        raise HTTPException(404, 'Line not found')
    db.query(Equipment).filter(Equipment.line_id == line_id).update(
        {Equipment.line_id: None}, synchronize_session=False,
    )
    db.query(KpiTarget).filter(KpiTarget.line_id == line_id).delete(synchronize_session=False)
    db.delete(line)
    audit(db, u, 'DELETE', 'PlantLine', line_id)
    db.commit()
    return {'ok': True}


@app.delete('/equipment/{equipment_id}')
def delete_equipment(equipment_id: str, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    equipment = db.query(Equipment).filter_by(equipment_id=equipment_id).first()
    if not equipment:
        raise HTTPException(404, 'Equipment not found')
    purge_kpi_history(db, [equipment.equipment_id])
    db.flush()
    db.delete(equipment)
    audit(db, u, 'DELETE', 'Equipment', equipment_id)
    db.commit()
    return {'ok': True}


@app.delete('/daily-reports/{report_id}')
def delete_daily_report(report_id: str, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    report = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not report:
        raise HTTPException(404, 'Daily report not found')
    db.query(DailyReportItem).filter_by(report_id=report.id).delete(synchronize_session=False)
    db.query(MachineRecord).filter_by(daily_report_id=report.id).delete(synchronize_session=False)
    db.delete(report)
    audit(db, u, 'DELETE', 'DailyReport', report_id)
    db.commit()
    return {'ok': True}


@app.delete('/lubrication-reports/{report_id}')
def delete_lubrication_report(report_id: str, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    report = db.query(LubricationReport).filter_by(report_id=report_id).first()
    if not report:
        raise HTTPException(404, 'Lubrication report not found')
    db.query(LubricationLine).filter_by(report_id=report.id).delete(synchronize_session=False)
    db.delete(report)
    audit(db, u, 'DELETE', 'LubricationReport', report_id)
    db.commit()
    return {'ok': True}


@app.delete('/work-orders/{work_order_id}')
def delete_work_order(work_order_id: str, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    order = db.query(WorkOrder).filter_by(work_order_id=work_order_id).first()
    if not order:
        raise HTTPException(404, 'Work order not found')
    remove_work_order(db, order)
    audit(db, u, 'DELETE', 'WorkOrder', work_order_id)
    db.commit()
    return {'ok': True}


@app.delete('/machine-records/{record_id}')
def delete_machine_record(record_id: int, db: Session = Depends(get_db), u=Depends(role(*ENGINEER))):
    record = db.get(MachineRecord, record_id)
    if not record:
        raise HTTPException(404, 'Machine record not found')
    db.delete(record)
    audit(db, u, 'DELETE', 'MachineRecord', record_id)
    db.commit()
    return {'ok': True}


@app.get('/machine-records')
def machine_records(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(MachineRecord)
    if equipment_id:q=q.filter(MachineRecord.equipment_id==equipment_id)
    if is_technician_account(u):
        if not u.technician_id:
            return []
        wo_ids = [row.work_order_id for row in visible_to_technician(db.query(WorkOrder), u.technician_id).all()]
        clauses = [MachineRecord.technician_id == u.technician_id]
        if wo_ids:
            clauses.append(MachineRecord.wo_id.in_(wo_ids))
        q = q.filter(or_(*clauses))
    return [as_dict(row) for row in q.order_by(MachineRecord.record_date.desc(),MachineRecord.id.desc()).all()]
@app.get('/iso-records')
def iso_records(db:Session=Depends(get_db),u=Depends(auth)): return db.query(ISORecord).order_by(ISORecord.document_number).all()
@app.post('/iso-records')
def create_iso(data:ISOCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    o=ISORecord(**data.model_dump()); db.add(o); audit(db,u,'CREATE','ISORecord',data.document_number,new=data.model_dump()); db.commit(); db.refresh(o); return o
@app.get('/notifications')
def notifications(db:Session=Depends(get_db),u=Depends(auth)): return db.query(Notification).filter(or_(Notification.user_id==u.id,Notification.user_id==None)).order_by(Notification.created_at.desc()).limit(100).all()
@app.post('/notifications/{nid}/read')
def notification_read(nid:int,db:Session=Depends(get_db),u=Depends(auth)):
    n=db.get(Notification,nid)
    if n and (n.user_id is None or n.user_id==u.id): n.is_read=True; db.commit()
    return {'ok':True}
@app.get('/audit')
def audit_log(db:Session=Depends(get_db),u=Depends(role(*DEVELOPER))): return db.query(AuditTrail).order_by(AuditTrail.created_at.desc()).limit(500).all()

@app.post('/automation/pm/run')
def run_pm_automation(db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    target=date.today()+timedelta(days=1); created=[]
    for p in db.query(PMPlan).filter(PMPlan.active==True,PMPlan.next_due_date==target).all():
        existing=db.query(WorkOrder).filter(WorkOrder.pm_id==p.pm_id,WorkOrder.status.notin_(['Closed','Cancelled'])).first()
        if existing: continue
        wid=f'WO-{target.year}-{db.query(WorkOrder).count()+1:05d}'
        w=WorkOrder(work_order_id=wid,work_order_type='Preventive',equipment_id=p.equipment_id,component_id=p.component_id,pm_id=p.pm_id,priority=p.priority,status='Open',problem_description='Scheduled PM',work_description=p.task,planned_date=p.next_due_date,created_by='SYSTEM')
        db.add(w); db.flush(); created.append(wid)
        for tech in db.query(User).filter(User.role.in_(tuple(TECHNICIAN)), User.is_active==True).all(): notify(db,tech.id,'PM Work Order Created',f'{wid} for {p.equipment_id} is due tomorrow','pm',wid)
    db.commit(); return {'created':created,'due_date':str(target)}

LUBE_SHIFTS = {
    'Morning (07:00 - 15:00)',
    'Evening (15:00 - 23:00)',
    'Night (23:00 - 07:00)',
}
LUBE_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
LUBE_WORK_TYPES = {'Oil change', 'Grease change', 'Other'}


def propose_lubrication_equipment(db, report, technician_id, code, name):
    """Send an unknown machine from the oil and grease log to the maintenance engineer."""
    existing = db.query(PendingEquipment).filter(
        func.lower(PendingEquipment.equipment_code) == code.lower(),
        PendingEquipment.status == 'Pending',
    ).first()
    if existing:
        existing.equipment_name = name[:150]
        existing.report_id = report.report_id
        existing.technician_id = technician_id
        return False
    db.add(PendingEquipment(
        equipment_code=code[:50],
        equipment_name=name[:150],
        report_id=report.report_id,
        technician_id=technician_id,
        status='Pending',
    ))
    engineers = db.query(User).filter(User.role == 'MAINTENANCE_ENGINEER', User.is_active == True).all()
    if not engineers:
        engineers = db.query(User).filter(User.role.in_(list(ENGINEER)), User.is_active == True).all()
    for engineer in engineers:
        notify(
            db,
            engineer.id,
            'معدات جديدة',
            f'{code} — {name} أُضيفت من تقرير الزيوت والشحوم وتحتاج إلى موافقة.',
            'pending_equipment',
            code,
        )
    return True


def lube_query(db: Session, u):
    query = db.query(LubricationReport)
    if is_technician_account(u):
        profile = provision_technician_profile(db, u)
        if not profile:
            return query.filter(LubricationReport.id == -1)
        query = query.filter(LubricationReport.technician_id == profile.technician_id)
    return query


def lube_payload(db: Session, row: LubricationReport):
    technician = db.query(Technician).filter_by(technician_id=row.technician_id).first()
    lines = db.query(LubricationLine).filter_by(report_id=row.id).order_by(
        LubricationLine.sort_order, LubricationLine.id
    ).all()
    return {
        'report_id': row.report_id,
        'report_date': row.report_date.isoformat(),
        'day_name': row.day_name,
        'shift': row.shift,
        'technician_id': row.technician_id,
        'technician_name': technician.name if technician else row.technician_id,
        'lines': [
            {
                'equipment_code': line.equipment_code,
                'equipment_name': line.equipment_name,
                'component': line.component,
                'quantity': line.quantity,
                'lubricant_name': line.lubricant_name,
                'notes': line.notes,
                'work_type': line.work_type or '',
                'work_order_id': line.work_order_id,
            }
            for line in lines
        ],
    }


def settle_oil_change_pm(db: Session, order: WorkOrder, done_on: date, code: str):
    """Complete one matching preventive occurrence and move its plan forward."""
    needle = code.strip().lower()
    linked = db.query(AnnualPMDayTask).filter(AnnualPMDayTask.work_order_id == order.work_order_id).first()
    if linked is None and needle:
        candidates = db.query(AnnualPMDayTask).filter(
            func.lower(AnnualPMDayTask.machine_code) == needle,
            AnnualPMDayTask.work_date <= done_on,
        ).order_by(AnnualPMDayTask.work_date.desc(), AnnualPMDayTask.id.desc()).all()
        open_tasks = []
        for task in candidates:
            if task.work_order_id and task.work_order_id != order.work_order_id:
                continue
            open_tasks.append(task)
        same_day = [
            task for task in open_tasks
            if task.work_date == done_on and (task.maintenance_type or 'Preventive') in ('Lubrication', 'Preventive')
        ]
        linked = next((task for task in same_day if task.maintenance_type == 'Lubrication'), None)
        if linked is None and same_day:
            linked = same_day[0]
        if linked is None:
            linked = next((task for task in open_tasks if task.maintenance_type == 'Lubrication'), None)
        if linked is not None:
            linked.work_order_id = order.work_order_id
            if linked.released_at is None:
                linked.released_at = datetime.utcnow()
    if order.pm_id or not needle:
        return
    plans = db.query(PMPlan).filter(PMPlan.active == True)
    if order.equipment_id:
        plans = plans.filter(PMPlan.equipment_id == order.equipment_id)
    else:
        plans = plans.filter(func.lower(PMPlan.manual_equipment_code) == needle)
    plan = None
    for candidate in plans.order_by(PMPlan.next_due_date).all():
        if candidate.next_due_date is None or candidate.next_due_date <= done_on:
            plan = candidate
            break
    if plan is None:
        return
    plan.last_pm_date = done_on
    plan.next_due_date = done_on + timedelta(days=_plan_cycle_days(plan))
    order.pm_id = plan.pm_id


def record_oil_change(db, user, report, technician_id, equipment, code, name, component, quantity, lubricant, notes, existing_order_id):
    """Record a finished oil change, its work order, and the machine history."""
    details = ' — '.join(part for part in (lubricant, quantity, component, notes) if part)
    text = f'Oil change: {details}' if details else 'Oil change'
    order = db.query(WorkOrder).filter_by(work_order_id=existing_order_id).first() if existing_order_id else None
    if order is None:
        work_order_id = next_work_order_id(db, report.report_date.year)
        done_at = datetime.combine(report.report_date, datetime.min.time())
        order = WorkOrder(
            work_order_id=work_order_id,
            work_order_type='Lubrication',
            equipment_id=equipment.equipment_id if equipment else None,
            manual_equipment_code=None if equipment else code,
            manual_equipment_name=None if equipment else name,
            manual_plant_id=equipment.plant_id if equipment else None,
            manual_line_id=equipment.line_id if equipment else None,
            priority='Medium',
            status='Completed',
            problem_description=text,
            work_description=text,
            corrective_action=text,
            result='Completed',
            planned_date=report.report_date,
            request_date=report.report_date,
            assigned_technician_id=technician_id,
            start_time=done_at,
            end_time=done_at,
            closing_date=done_at,
            closed_by=getattr(user, 'username', None) or 'SYSTEM',
            created_by=getattr(user, 'username', None) or 'SYSTEM',
            records_committed=True,
        )
        db.add(order)
        db.flush()
        db.add(WorkOrderAssignment(
            work_order_id=order.work_order_id,
            technician_id=technician_id,
            response='Accepted',
            assigned_at=datetime.utcnow(),
            responded_at=datetime.utcnow(),
        ))
        audit(db, user, 'AUTO_CREATE', 'WorkOrder', order.work_order_id, new={
            'source': 'Lubrication report',
            'report_id': report.report_id,
            'equipment': code,
        })
    else:
        order.work_description = text
        order.problem_description = text
        order.corrective_action = text
        order.status = 'Completed'
    record = db.query(MachineRecord).filter_by(wo_id=order.work_order_id).first()
    if record is None:
        record = MachineRecord(
            equipment_id=equipment.equipment_id if equipment else code,
            record_date=report.report_date,
            record_type='Oil change',
            wo_id=order.work_order_id,
            technician_id=technician_id,
            description=text,
            action=text,
        )
        db.add(record)
    else:
        record.description = text
        record.action = text
        record.record_date = report.report_date
    settle_oil_change_pm(db, order, report.report_date, code)
    if order.pm_id:
        record.pm_id = order.pm_id
    return order.work_order_id


@app.get('/lubrication-reports')
def lubrication_reports(db: Session = Depends(get_db), u=Depends(auth)):
    rows = lube_query(db, u).order_by(LubricationReport.report_date.desc(), LubricationReport.id.desc()).all()
    result = []
    for row in rows:
        item = lube_payload(db, row)
        item['line_count'] = len(item['lines'])
        item.pop('lines')
        result.append(item)
    return result


@app.get('/lubrication-reports/{report_id}')
def lubrication_report(report_id: str, db: Session = Depends(get_db), u=Depends(auth)):
    row = lube_query(db, u).filter(LubricationReport.report_id == report_id).first()
    if not row:
        raise HTTPException(404, 'Lubrication report not found')
    return lube_payload(db, row)


@app.put('/lubrication-reports')
def save_lubrication_report(data: LubricationSave, db: Session = Depends(get_db), u=Depends(auth)):
    if u.role == 'ADMINISTRATOR_VIEWER':
        raise HTTPException(403, 'Insufficient permission')
    if data.shift not in LUBE_SHIFTS:
        raise HTTPException(400, 'Choose a shift')
    if len(data.lines) > 40:
        raise HTTPException(400, 'A lubrication report can hold 40 lines')
    if is_technician_account(u):
        profile = provision_technician_profile(db, u)
        if not profile:
            raise HTTPException(400, 'Your account is not linked to a technician')
        technician_id = profile.technician_id
    else:
        technician_id = (data.technician_id or '').strip()
        if not technician_id:
            raise HTTPException(400, 'Choose the lubrication technician')
    technician = db.query(Technician).filter(func.lower(Technician.technician_id) == technician_id.lower()).first()
    if not technician:
        raise HTTPException(404, 'Technician not found')
    technician_id = technician.technician_id
    row = db.query(LubricationReport).filter(
        LubricationReport.technician_id == technician_id,
        LubricationReport.report_date == data.report_date,
    ).first()
    created = row is None
    if created:
        report_id = f'LR-{data.report_date.year}-{db.query(LubricationReport).count() + 1:05d}'
        row = LubricationReport(
            report_id=report_id,
            report_date=data.report_date,
            technician_id=technician_id,
            shift=data.shift,
            day_name=LUBE_DAYS[data.report_date.weekday()],
        )
        db.add(row)
        db.flush()
    else:
        row.shift = data.shift
        row.day_name = LUBE_DAYS[data.report_date.weekday()]
    previous = db.query(LubricationLine).filter(LubricationLine.report_id == row.id).all()
    reuse = {}
    for old in previous:
        if old.work_order_id and old.work_type == 'Oil change' and old.equipment_code:
            reuse.setdefault(old.equipment_code.lower(), []).append(old.work_order_id)
    db.query(LubricationLine).filter(LubricationLine.report_id == row.id).delete()
    kept = 0
    proposed = []
    for line in data.lines:
        code = line.equipment_code.strip()
        name = line.equipment_name.strip()
        component = line.component.strip()
        quantity = line.quantity.strip()
        lubricant = line.lubricant_name.strip()
        notes = line.notes.strip()
        work_type = line.work_type.strip()
        if not any((code, name, component, quantity, lubricant, notes, work_type)):
            continue
        if work_type not in LUBE_WORK_TYPES:
            raise HTTPException(400, 'Choose the work type')
        if work_type == 'Oil change' and not code:
            raise HTTPException(400, 'Enter the equipment number for an oil change')
        found = db.query(Equipment).filter(func.lower(Equipment.equipment_id) == code.lower()).first() if code else None
        if found:
            code = found.equipment_id
            name = found.name
        elif code:
            if not name:
                raise HTTPException(400, 'Enter the equipment name so the engineer can approve it.')
            if propose_lubrication_equipment(db, row, technician_id, code, name):
                proposed.append(code)
        work_order_id = None
        if work_type == 'Oil change':
            pooled = reuse.get(code.lower(), [])
            existing_order = pooled.pop(0) if pooled else None
            work_order_id = record_oil_change(
                db, u, row, technician_id, found, code, name, component, quantity, lubricant, notes, existing_order,
            )
        db.add(LubricationLine(
            report_id=row.id,
            sort_order=kept,
            equipment_code=code[:50],
            equipment_name=name[:150],
            component=component[:150],
            quantity=quantity[:40],
            lubricant_name=lubricant[:150],
            notes=notes,
            work_type=work_type,
            work_order_id=work_order_id,
        ))
        kept += 1
    audit(db, u, 'CREATE' if created else 'UPDATE', 'LubricationReport', row.report_id, new={
        'date': str(data.report_date),
        'technician_id': technician_id,
        'lines': kept,
    })
    db.commit()
    db.refresh(row)
    payload = lube_payload(db, row)
    payload['new_equipment'] = proposed
    return payload


def _motor_temp(value):
    text = (value or '').strip().replace(',', '.')
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def motor_equipment_index(db):
    equipment = db.query(Equipment).all()
    plants = {row.plant_id: row.name for row in db.query(Plant).all()}
    lines = {row.line_id: row for row in db.query(PlantLine).all()}
    by_code = {}
    details = {}
    for row in equipment:
        line = lines.get(row.line_id)
        line_number = '' if line is None or line.line_number is None else str(line.line_number)
        detail = {
            'equipment_id': row.equipment_id,
            'name': row.name or '',
            'label': f'{row.equipment_id} — {row.name}',
            'plant_id': row.plant_id or '',
            'plant_name': plants.get(row.plant_id) or '',
            'line_id': row.line_id or '',
            'line_number': line_number,
        }
        by_code[row.equipment_id.lower()] = row
        details[row.equipment_id] = detail
    return by_code, details


def motor_due_equipment(db, day):
    """Preventive tasks for this day, limited to equipment that exists in the register."""
    by_code, details = motor_equipment_index(db)
    inactive_plants = {row.plant_id for row in db.query(Plant).all() if row.active is False}
    chosen = []
    seen = set()

    def add(equipment):
        if equipment.plant_id and equipment.plant_id in inactive_plants:
            return
        if equipment.equipment_id in seen:
            return
        seen.add(equipment.equipment_id)
        chosen.append(details[equipment.equipment_id])

    tasks = db.query(AnnualPMDayTask).filter(AnnualPMDayTask.work_date == day).all()
    for task in tasks:
        if (task.maintenance_type or 'Preventive').strip().lower() != 'preventive':
            continue
        found = by_code.get((task.machine_code or '').strip().lower())
        if found:
            add(found)
    plans = db.query(PMPlan).filter(
        PMPlan.active == True,
        PMPlan.next_due_date == day,
        PMPlan.equipment_id.isnot(None),
    ).all()
    for plan in plans:
        if (plan.pm_type or 'Preventive').strip().lower() not in ('', 'preventive'):
            continue
        found = by_code.get((plan.equipment_id or '').strip().lower())
        if found:
            add(found)
    chosen.sort(key=lambda row: (
        row['plant_name'].lower(),
        int(row['line_number']) if str(row['line_number']).isdigit() else 0,
        row['equipment_id'].lower(),
    ))
    return chosen


def motor_chart(db, plant_id, line_id, equipment_id, start, end):
    """Temperature and oil charts for the KPI page. This does not change the KPI equations."""
    rows = db.query(MotorConditionReading, MotorConditionReport).join(
        MotorConditionReport, MotorConditionReport.id == MotorConditionReading.report_id
    ).filter(
        MotorConditionReport.report_date >= start,
        MotorConditionReport.report_date <= end,
    ).all()
    by_code, _details = motor_equipment_index(db)
    temp_1 = {}
    temp_2 = {}
    oil_level = {'good': 0, 'add': 0}
    oil_condition = {'good': 0, 'critical': 0, 'change': 0}
    recorded = 0
    for reading, report in rows:
        code = (reading.equipment_id or (reading.machine or '').split('—')[0]).strip().lower()
        found = by_code.get(code)
        if equipment_id and (not found or found.equipment_id != equipment_id):
            continue
        if plant_id and (not found or found.plant_id != plant_id):
            continue
        if line_id and (not found or found.line_id != line_id):
            continue
        recorded += 1
        day = report.report_date.isoformat()
        first = _motor_temp(reading.temp_1)
        second = _motor_temp(reading.temp_2)
        if first is not None:
            temp_1.setdefault(day, []).append(first)
        if second is not None:
            temp_2.setdefault(day, []).append(second)
        if reading.oil_level in oil_level:
            oil_level[reading.oil_level] += 1
        if reading.oil_condition in oil_condition:
            oil_condition[reading.oil_condition] += 1
    days = sorted(set(temp_1) | set(temp_2))[-12:]

    def series(bucket, key, name):
        return {
            'id': key,
            'name': name,
            'points': [{
                'date': day,
                'hours': round(sum(bucket[day]) / len(bucket[day]), 1) if bucket.get(day) else None,
            } for day in days],
        }

    level_names = [('good', 'Oil good'), ('add', 'Needs adding')]
    condition_names = [('good', 'Oil good'), ('critical', 'Oil critical'), ('change', 'Needs replacement')]
    return {
        'readings': recorded,
        'temperature': [
            series(temp_1, 'temp_1', 'Temperature 1'),
            series(temp_2, 'temp_2', 'Temperature 2'),
        ],
        'oil_level': [{'name': label, 'value': oil_level[key]} for key, label in level_names if oil_level[key]],
        'oil_condition': [{'name': label, 'value': oil_condition[key]} for key, label in condition_names if oil_condition[key]],
    }


def motor_payload(db, row):
    readings = db.query(MotorConditionReading).filter(
        MotorConditionReading.report_id == row.id
    ).order_by(MotorConditionReading.sort_order, MotorConditionReading.id).all()
    place = motor_place(row.group_key, row.place_key) or {}
    return {
        'report_id': row.report_id,
        'report_date': row.report_date.isoformat(),
        'inspection_time': row.inspection_time or '',
        'inspector_name': row.inspector_name or '',
        'group_key': row.group_key,
        'place_key': row.place_key,
        'place_title': place.get('title', ''),
        'notes': row.notes or '',
        'readings': [{
            'machine': item.machine or '',
            'equipment_id': item.equipment_id or '',
            'plant': item.plant or '',
            'line_number': item.line_number or '',
            'temp_1': item.temp_1 or '',
            'temp_2': item.temp_2 or '',
            'oil_level': item.oil_level or '',
            'oil_condition': item.oil_condition or '',
            'inspection_time': item.inspection_time or '',
        } for item in readings],
    }


@app.get('/motor-condition/catalog')
def motor_catalog(u=Depends(role(*MOTOR))):
    return motor_catalog_payload()


@app.get('/motor-condition/due')
def motor_due(on: date, db: Session = Depends(get_db), u=Depends(role(*MOTOR))):
    return motor_due_equipment(db, on)


def motor_sheet_summaries(db):
    """Daily motor reports for the list on the motor page."""
    rows = db.query(MotorConditionReport).order_by(
        MotorConditionReport.report_date.desc(), MotorConditionReport.id.desc()
    ).limit(1000).all()
    ids = [row.id for row in rows]
    grouped = {}
    if ids:
        readings = db.query(MotorConditionReading).filter(
            MotorConditionReading.report_id.in_(ids)
        ).order_by(MotorConditionReading.sort_order, MotorConditionReading.id).all()
        for reading in readings:
            grouped.setdefault(reading.report_id, []).append(reading)
    payload = []
    for row in rows:
        equipment = []
        plants = []
        lines = []
        for item in grouped.get(row.id, []):
            label = (item.machine or item.equipment_id or '').strip()
            if label and label not in equipment:
                equipment.append(label)
            plant = (item.plant or '').strip()
            if plant and plant not in plants:
                plants.append(plant)
            line_number = (item.line_number or '').strip()
            if line_number and line_number not in lines:
                lines.append(line_number)
        payload.append({
            'report_id': row.report_id,
            'report_date': row.report_date.isoformat(),
            'inspection_time': row.inspection_time or '',
            'inspector_name': row.inspector_name or '',
            'group_key': row.group_key,
            'place_key': row.place_key,
            'equipment': equipment,
            'plants': plants,
            'lines': lines,
        })
    return payload


@app.get('/motor-condition')
def motor_sheets(db: Session = Depends(get_db), u=Depends(role(*MOTOR))):
    return motor_sheet_summaries(db)


@app.get('/motor-condition/{report_id}')
def motor_sheet(report_id: str, db: Session = Depends(get_db), u=Depends(role(*MOTOR))):
    row = db.query(MotorConditionReport).filter(MotorConditionReport.report_id == report_id).first()
    if not row:
        raise HTTPException(404, 'Motor condition sheet not found')
    return motor_payload(db, row)


@app.put('/motor-condition')
def save_motor_sheet(data: MotorConditionSave, db: Session = Depends(get_db), u=Depends(role(*MOTOR))):
    if not motor_sheet_allowed(data.group_key, data.place_key):
        raise HTTPException(400, 'Choose a group from the form')
    incoming = []
    seen = set()
    by_code, details = motor_equipment_index(db)
    for reading in data.readings:
        code = (reading.equipment_id or (reading.machine or '').split('—')[0]).strip()
        found = by_code.get(code.lower())
        if not found:
            raise HTTPException(400, 'This equipment is not in the system')
        if found.equipment_id in seen:
            continue
        seen.add(found.equipment_id)
        detail = details[found.equipment_id]
        temp_1 = (reading.temp_1 or '').strip()[:20]
        temp_2 = (reading.temp_2 or '').strip()[:20]
        oil_level = (reading.oil_level or '').strip()
        oil_condition = (reading.oil_condition or '').strip()
        checked_at = (reading.inspection_time or '').strip()[:8]
        if not any((temp_1, temp_2, oil_level, oil_condition, checked_at)):
            continue
        if oil_level not in OIL_LEVELS or oil_condition not in OIL_CONDITIONS:
            raise HTTPException(400, 'Choose an oil level and oil condition from the list')
        incoming.append((detail['label'], detail['plant_name'], detail['line_number'], temp_1, temp_2, oil_level, oil_condition, checked_at, found.equipment_id))
    if len(incoming) > 120:
        raise HTTPException(400, 'The sheet holds 120 equipment rows')
    clock = (data.inspection_time or '').strip()[:8]
    inspector = (data.inspector_name or '').strip()[:150] or (u.full_name or u.username)
    notes = (data.notes or '').strip()[:4000]
    row = db.query(MotorConditionReport).filter(
        MotorConditionReport.group_key == data.group_key,
        MotorConditionReport.place_key == data.place_key,
        MotorConditionReport.report_date == data.report_date,
    ).first()
    created = row is None
    if created:
        number = db.query(MotorConditionReport).count() + 1
        report_id = f'MC-{data.report_date.year}-{number:05d}'
        while db.query(MotorConditionReport).filter(MotorConditionReport.report_id == report_id).first():
            number += 1
            report_id = f'MC-{data.report_date.year}-{number:05d}'
        row = MotorConditionReport(
            report_id=report_id,
            report_date=data.report_date,
            group_key=data.group_key,
            place_key=data.place_key,
            created_by=u.username,
        )
        db.add(row)
        db.flush()
    row.inspection_time = clock
    row.inspector_name = inspector
    row.notes = notes
    db.query(MotorConditionReading).filter(MotorConditionReading.report_id == row.id).delete()
    for index, item in enumerate(incoming):
        machine, plant, line_number, temp_1, temp_2, oil_level, oil_condition, checked_at, equipment_id = item
        db.add(MotorConditionReading(
            report_id=row.id,
            sort_order=index,
            machine=machine,
            equipment_id=equipment_id,
            plant=plant,
            line_number=line_number,
            temp_1=temp_1,
            temp_2=temp_2,
            oil_level=oil_level,
            oil_condition=oil_condition,
            inspection_time=checked_at,
        ))
    audit(db, u, 'CREATE' if created else 'UPDATE', 'MotorConditionReport', row.report_id, new={
        'date': str(data.report_date),
        'group': data.group_key,
        'place': data.place_key,
        'readings': len(incoming),
    })
    db.commit()
    db.refresh(row)
    return motor_payload(db, row)


@app.get('/dashboard')
def dashboard(db:Session=Depends(get_db),u=Depends(auth)):
    today=date.today(); wo_total=db.query(func.count(WorkOrder.id)).scalar() or 0; open_wo=db.query(func.count(WorkOrder.id)).filter(WorkOrder.status.notin_(['Closed','Cancelled'])).scalar() or 0
    overdue=db.query(func.count(WorkOrder.id)).filter(WorkOrder.planned_date<today,WorkOrder.status.notin_(['Closed','Cancelled'])).scalar() or 0
    pm_due=db.query(func.count(PMPlan.id)).filter(PMPlan.active==True,PMPlan.next_due_date<=today+timedelta(days=1)).scalar() or 0
    pm_over=db.query(func.count(PMPlan.id)).filter(PMPlan.active==True,PMPlan.next_due_date<today).scalar() or 0
    eq={s:db.query(func.count(Equipment.id)).filter(Equipment.status==s).scalar() or 0 for s in EQUIPMENT_STATUSES}
    return {'equipment':db.query(func.count(Equipment.id)).scalar() or 0,'open_work_orders':open_wo,'work_orders_total':wo_total,'overdue_work_orders':overdue,'technicians':db.query(func.count(Technician.id)).filter(Technician.status=='Active').scalar() or 0,'daily_reports':db.query(func.count(DailyReport.id)).scalar() or 0,'pm_due':pm_due,'pm_overdue':pm_over,'equipment_status':eq}

@app.post('/seed')
def seed(db:Session=Depends(get_db)):
    created = bootstrap_system(db)
    return {'ok': True, 'message': 'Bootstrap account and baseline CMMS data created' if created else 'System already initialized or bootstrap is disabled'}

# The web app is served by the same FastAPI host as the API. This avoids a
# separate frontend server and lets browser calls use one trusted origin.
web_root = Path(os.getenv('WEB_ROOT', '/app/web'))

@app.get('/manifest.webmanifest', include_in_schema=False)
def web_manifest():
    return FileResponse(web_root / 'manifest.webmanifest', media_type='application/manifest+json')

@app.get('/sw.js', include_in_schema=False)
def service_worker():
    return FileResponse(
        web_root / 'sw.js',
        media_type='application/javascript',
        headers={'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/'},
    )

if web_root.exists():
    app.mount('/', StaticFiles(directory=web_root, html=True), name='web')
