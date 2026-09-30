import os
from datetime import datetime, timedelta
from jose import jwt
from passlib.context import CryptContext

SECRET_KEY = os.getenv('JWT_SECRET')
if not SECRET_KEY:
    raise RuntimeError('JWT_SECRET must be configured before starting the API')

ALGORITHM='HS256'
pwd_context=CryptContext(schemes=['bcrypt'],deprecated='auto')
def hash_password(p): return pwd_context.hash(p)
def verify_password(p,h): return pwd_context.verify(p,h)
def create_access_token(user_id,username,role):
    return jwt.encode({'sub':str(user_id),'username':username,'role':role,'exp':datetime.utcnow()+timedelta(hours=12)},SECRET_KEY,algorithm=ALGORITHM)
def decode_token(token): return jwt.decode(token,SECRET_KEY,algorithms=[ALGORITHM])
