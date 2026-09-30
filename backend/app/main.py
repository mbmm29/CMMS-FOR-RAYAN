import os
from datetime import date, datetime, timedelta
import json
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from sqlalchemy import func, or_, inspect, text
from .database import Base, engine, get_db, SessionLocal
from .models import *
from .schemas import *
from .security import *

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
):
    if local_origin not in cors_origins:
        cors_origins.append(local_origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'PUT', 'DELETE'],
    allow_headers=['Authorization', 'Content-Type'],
)

ROLES = {
    'SYSTEM_DEVELOPER',
    'MAINTENANCE_ENGINEER',
    'TECHNICIAN',
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
}

VIEWER = {
    'ADMINISTRATOR_VIEWER',
}
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
        for account in db.query(User).filter(User.role == 'TECHNICIAN').all():
            provision_technician_profile(db, account)
        db.commit()
    finally:
        db.close()

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

@app.get('/users',response_model=list[UserOut])
def users(db:Session=Depends(get_db),u=Depends(role(*DEVELOPER))): return db.query(User).order_by(User.username).all()

def provision_technician_profile(db: Session, account: User):
    """Create/resolve the operational profile required by technician reports."""
    technician_id = (account.technician_id or '').strip()
    if account.role != 'TECHNICIAN' or not technician_id:
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
    if data.role == 'TECHNICIAN' and not (data.technician_id or '').strip():
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
    if account.role == 'TECHNICIAN' and not (account.technician_id or '').strip():
        raise HTTPException(400, 'Technician ID is required for a technician account')
    provision_technician_profile(db, account)
    audit(db, u, 'UPDATE', 'User', account.username, old=old, new=data.model_dump(exclude={'password'}, exclude_unset=True))
    db.commit(); db.refresh(account); return account

@app.get('/plants')
def plants(db:Session=Depends(get_db),u=Depends(auth)): return db.query(Plant).all()
@app.post('/plants')
def create_plant(data:PlantCreate,db:Session=Depends(get_db),u=Depends(role(*DEVELOPER))):
    o=Plant(**data.model_dump()); db.add(o); audit(db,u,'CREATE','Plant',data.plant_id,new=data.model_dump()); db.commit(); db.refresh(o); return o
@app.get('/lines')
def lines(plant_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(PlantLine)
    if plant_id:q=q.filter(PlantLine.plant_id==plant_id)
    return q.all()
@app.post('/lines')
def create_line(data:LineCreate,db:Session=Depends(get_db),u=Depends(role(*DEVELOPER))):
    o=PlantLine(**data.model_dump()); db.add(o); audit(db,u,'CREATE','Line',data.line_id,new=data.model_dump()); db.commit(); db.refresh(o); return o

@app.get('/equipment',response_model=list[EquipmentOut])
def list_equipment(line_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(Equipment)
    if line_id:q=q.filter(Equipment.line_id==line_id)
    return q.order_by(Equipment.equipment_id).all()

@app.get('/equipment/lookup')
def lookup_equipment(code: str, db: Session = Depends(get_db), u=Depends(auth)):
    """Resolve a typed equipment code for the Daily Report form."""
    clean_code = code.strip()
    if not clean_code:
        raise HTTPException(400, 'Equipment code is required')
    matches = db.query(Equipment).filter(
        func.lower(Equipment.equipment_id) == clean_code.lower()
    ).all()
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
        })
    return {'matches': results}

STATUSES = {
    "Open",
    "In Progress",
    "Completed",
    "Cancelled",
    "Closed",
}
@app.post('/equipment',response_model=EquipmentOut)
def create_equipment(data:EquipmentCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    if data.status not in STATUSES: raise HTTPException(400,'Invalid equipment status')
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

@app.get('/sops')
def sops(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(SOP)
    if equipment_id:q=q.filter(SOP.equipment_id==equipment_id)
    return q.order_by(SOP.sop_id).all()
@app.post('/sops')
def create_sop(data:SOPCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    sid=f'SOP-{data.equipment_id}-{db.query(SOP).filter(SOP.equipment_id==data.equipment_id).count()+1:03d}'
    o=SOP(sop_id=sid,**data.model_dump()); db.add(o); audit(db,u,'CREATE','SOP',sid,new=data.model_dump()); db.commit(); db.refresh(o); return o

@app.get('/work-orders',response_model=list[WOOut])
def work_orders(status:str|None=None,equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(WorkOrder)
    if status:q=q.filter(WorkOrder.status==status)
    if equipment_id:q=q.filter(WorkOrder.equipment_id==equipment_id)
    return q.order_by(WorkOrder.id.desc()).all()
@app.post('/work-orders',response_model=WOOut)
def create_work_order(data:WOCreate,db:Session=Depends(get_db),u=Depends(role(*ENGINEER))):
    if not data.equipment_id and not data.manual_equipment_code:
        raise HTTPException(400, 'Equipment or manual equipment code is required')
    if data.equipment_id and not db.query(Equipment).filter_by(equipment_id=data.equipment_id).first():
        raise HTTPException(404, 'Equipment not found')
    wid=data.work_order_id or f'WO-{date.today().year}-{db.query(WorkOrder).count()+1:05d}'
    if db.query(WorkOrder).filter_by(work_order_id=wid).first(): raise HTTPException(409,'Work Order ID exists')
    o=WorkOrder(work_order_id=wid,created_by=u.username,**data.model_dump(exclude={'work_order_id'})); db.add(o); audit(db,u,'CREATE','WorkOrder',wid,new=data.model_dump()); db.commit(); db.refresh(o); return o
@app.put('/work-orders/{wo_id}',response_model=WOOut)
def update_work_order(wo_id:str,data:WOUpdate,db:Session=Depends(get_db),u=Depends(auth)):
    o=db.query(WorkOrder).filter_by(work_order_id=wo_id).first()
    if not o: raise HTTPException(404,'Work Order not found')
    payload=data.model_dump(exclude_unset=True)
    if u.role=='TECHNICIAN':
        allowed={'status','start_time','end_time','downtime_h','labor_hours','failure_mode','failure_cause','corrective_action','result','parts_used'}
        if set(payload)-allowed: raise HTTPException(403,'Technician cannot modify this field')
        if payload.get('status')=='Closed': raise HTTPException(403,'Technician cannot close Work Order')
    elif u.role not in ENGINEER: raise HTTPException(403,'Read only account')
    old={k:getattr(o,k) for k in payload}
    for k,v in payload.items(): setattr(o,k,v)
    if o.status=='Closed': o.closed_by=u.username; o.closing_date=datetime.utcnow()
    audit(db,u,'UPDATE','WorkOrder',wo_id,old=old,new=payload); db.commit(); db.refresh(o); return o

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

    # Inspection, routine, lubrication, and emergency entries remain machine
    # history only. The project workflow creates WOs automatically solely for
    # preventive and corrective maintenance.
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
    if u.role == 'TECHNICIAN':
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

    if u.role == 'TECHNICIAN' and r.technician_id != u.technician_id:
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
    if u.role == 'TECHNICIAN':
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
            if w.assigned_technician_id is None:
                w.assigned_technician_id = technician_id

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

        # Automatic Machine Record from every equipment mentioned in the report.
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

    if u.role == 'TECHNICIAN' and r.technician_id != u.technician_id:
        raise HTTPException(403, 'You can only edit your own reports')

    old = {
        'report_date': r.report_date,
        'shift': r.shift,
        'shift_engineer': r.shift_engineer,
    }

    if data.report_date is not None:
        r.report_date = data.report_date
    if data.shift is not None:
        r.shift = data.shift
    if data.shift_engineer is not None:
        r.shift_engineer = data.shift_engineer
    if data.general_notes is not None:
        r.general_notes = data.general_notes

    if data.items is not None:
        if not data.items:
            raise HTTPException(400, 'Daily Report must contain at least one item')

        # For the first implementation, rebuild item rows while the report is
        # still Draft/Returned. This keeps the API deterministic and avoids
        # duplicate Machine Records/WO links.
        db.query(DailyReportItem).filter(
            DailyReportItem.report_id == r.id
        ).delete(synchronize_session=False)

        for item in data.items:
            validate_report_item(db, item)
            payload = item.model_dump()
            if item.downtime_start is not None and item.downtime_end is not None:
                payload['downtime_h'] = calculate_downtime(
                    item.downtime_start, item.downtime_end
                )
            row = DailyReportItem(report_id=r.id, **payload)
            db.add(row)

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


@app.post('/daily-reports/{report_id}/submit')
def submit_report(
    report_id: str,
    db: Session = Depends(get_db),
    u=Depends(auth),
):
    r = db.query(DailyReport).filter_by(report_id=report_id).first()
    if not r:
        raise HTTPException(404, 'Daily Report not found')

    if u.role == 'TECHNICIAN' and r.technician_id != u.technician_id:
        raise HTTPException(403, 'You can only submit your own report')

    if r.locked_at:
        raise HTTPException(409, 'Report is locked')

    if r.status not in ('Draft', 'Returned'):
        raise HTTPException(
            409,
            f'Report cannot be submitted from status {r.status}'
        )

    items = db.query(DailyReportItem).filter_by(report_id=r.id).all()
    if not items:
        raise HTTPException(400, 'Cannot submit an empty Daily Report')

    # Registered equipment must exist. Manual entries are valid because a
    # technician is allowed to report equipment not registered in the CMMS.
    for item in items:
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

    r.status = 'Returned'

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
                f'{r.report_id} was returned by {u.full_name}. Reason: {reason or "See report"}',
                'daily_report_returned',
                r.report_id,
            )

    db.commit()
    db.refresh(r)
    return r

@app.get('/machine-records')
def machine_records(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    q=db.query(MachineRecord)
    if equipment_id:q=q.filter(MachineRecord.equipment_id==equipment_id)
    return q.order_by(MachineRecord.record_date.desc(),MachineRecord.id.desc()).all()
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
        for tech in db.query(User).filter(User.role=='TECHNICIAN',User.is_active==True).all(): notify(db,tech.id,'PM Work Order Created',f'{wid} for {p.equipment_id} is due tomorrow','pm',wid)
    db.commit(); return {'created':created,'due_date':str(target)}

@app.get('/dashboard')
def dashboard(db:Session=Depends(get_db),u=Depends(auth)):
    today=date.today(); wo_total=db.query(func.count(WorkOrder.id)).scalar() or 0; open_wo=db.query(func.count(WorkOrder.id)).filter(WorkOrder.status.notin_(['Closed','Cancelled'])).scalar() or 0
    overdue=db.query(func.count(WorkOrder.id)).filter(WorkOrder.planned_date<today,WorkOrder.status.notin_(['Closed','Cancelled'])).scalar() or 0
    pm_due=db.query(func.count(PMPlan.id)).filter(PMPlan.active==True,PMPlan.next_due_date<=today+timedelta(days=1)).scalar() or 0
    pm_over=db.query(func.count(PMPlan.id)).filter(PMPlan.active==True,PMPlan.next_due_date<today).scalar() or 0
    eq={s:db.query(func.count(Equipment.id)).filter(Equipment.status==s).scalar() or 0 for s in STATUSES}
    return {'equipment':db.query(func.count(Equipment.id)).scalar() or 0,'open_work_orders':open_wo,'work_orders_total':wo_total,'overdue_work_orders':overdue,'technicians':db.query(func.count(Technician.id)).filter(Technician.status=='Active').scalar() or 0,'daily_reports':db.query(func.count(DailyReport.id)).scalar() or 0,'pm_due':pm_due,'pm_overdue':pm_over,'equipment_status':eq}

@app.get('/kpi')
def kpi(equipment_id:str|None=None,db:Session=Depends(get_db),u=Depends(auth)):
    wq=db.query(WorkOrder); rq=db.query(DailyReportItem); eq=db.query(Equipment)
    if equipment_id:wq=wq.filter(WorkOrder.equipment_id==equipment_id); rq=rq.filter(DailyReportItem.equipment_id==equipment_id); eq=eq.filter(Equipment.equipment_id==equipment_id)
    corrective=wq.filter(WorkOrder.work_order_type=='Corrective').all(); preventive=wq.filter(WorkOrder.work_order_type=='Preventive').all()
    failures=len([w for w in corrective if w.failure_mode or w.failure_cause or w.problem_description])
    repair=sum((w.labor_hours or 0) for w in corrective); total_hours=sum((w.labor_hours or 0) for w in wq.all())
    downtime=sum((r.downtime_h or 0) for r in rq.all()); operating=sum((e.operating_hours or 0) for e in eq.all())
    mtbf=operating/failures if failures else 0; mttr=repair/failures if failures else 0
    pm_done=sum(1 for w in preventive if w.status=='Closed'); pm_due=len(preventive); pm_comp=pm_done/pm_due*100 if pm_due else 0
    return {'availability_percent':None,'mtbf':round(mtbf,2),'mttr':round(mttr,2),'pm_compliance_percent':round(pm_comp,2),'pm_overdue':db.query(PMPlan).filter(PMPlan.active==True,PMPlan.next_due_date<date.today()).count(),'planned_pm_percent':round(len(preventive)/(len(preventive)+len(corrective)*0+1)*100,2) if preventive else 0,'corrective_maintenance_percent':round(sum((w.labor_hours or 0) for w in corrective)/total_hours*100,2) if total_hours else 0,'preventive_maintenance_percent':round(sum((w.labor_hours or 0) for w in preventive)/total_hours*100,2) if total_hours else 0,'total_maintenance_hours':round(total_hours,2),'downtime_h':round(downtime,2),'failure_count':failures,'failure_rate':round(failures/operating,6) if operating else 0}

@app.post('/seed')
def seed(db:Session=Depends(get_db)):
    created = bootstrap_system(db)
    return {'ok': True, 'message': 'Bootstrap account and baseline CMMS data created' if created else 'System already initialized or bootstrap is disabled'}

# The web app is served by the same FastAPI host as the API. This avoids a
# separate frontend server and lets browser calls use one trusted origin.
web_root = Path(os.getenv('WEB_ROOT', '/app/web'))
if web_root.exists():
    app.mount('/', StaticFiles(directory=web_root, html=True), name='web')
