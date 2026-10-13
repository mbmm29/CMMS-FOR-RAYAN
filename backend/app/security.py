import os
from datetime import datetime, timedelta
from jose import jwt
from passlib.context import CryptContext

SECRET_KEY = os.getenv('JWT_SECRET')
if not SECRET_KEY:
    raise RuntimeError('JWT_SECRET must be configured before starting the API')

ALGORITHM = 'HS256'
pwd_context = CryptContext(schemes=['bcrypt'], deprecated='auto')


def hash_password(p):
    return pwd_context.hash(p)


def verify_password(p, h):
    return pwd_context.verify(p, h)


def access_token_ttl():
    """Stay signed in until the user signs out. Default: 10 years."""
    raw = (os.getenv('JWT_EXPIRE_DAYS') or '3650').strip()
    try:
        days = int(raw)
    except ValueError:
        days = 3650
    return timedelta(days=max(1, days))


def create_access_token(user_id, username, role):
    now = datetime.utcnow()
    return jwt.encode(
        {
            'sub': str(user_id),
            'username': username,
            'role': role,
            'iat': now,
            'exp': now + access_token_ttl(),
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def decode_token(token):
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
