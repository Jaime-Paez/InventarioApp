import os
import runpy
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
os.chdir(BASE_DIR)

os.environ['DEBUG'] = '1'
os.environ['ALLOWED_HOSTS'] = 'localhost,127.0.0.1,0.0.0.0,192.168.0.72,192.168.0.128,inventarioapp-0mta.onrender.com,.onrender.com'
os.environ['CORS_ALLOWED_ORIGINS'] = 'http://localhost:5173,http://127.0.0.1:5173,http://192.168.0.72:5173,http://192.168.0.128:5173,https://kavajaimepaez.onrender.com'
os.environ['CSRF_TRUSTED_ORIGINS'] = 'http://localhost:5173,http://192.168.0.72:5173,http://192.168.0.128:5173,https://kavajaimepaez.onrender.com'

sys.argv = ['manage.py', 'runserver', '0.0.0.0:8000']
runpy.run_path(str(BASE_DIR / 'manage.py'), run_name='__main__')
