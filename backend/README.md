# Backend setup and auth notes

La capa de autenticación ahora usa `rest_framework.authtoken` para emitir tokens en los endpoints `/auth/register/` y `/auth/login/`. Si ves errores como `relation "authtoken_token" does not exist`, significa que faltan migraciones.

## Pasos de inicialización (desarrollo)

1. Instala dependencias:
   ```bash
   pip install -r requirements.txt
   ```
2. Ejecuta las migraciones nuevas (incluye `authtoken`):
   ```bash
   python manage.py migrate
   ```
   Si ya tienes la base creada, puedes aplicar solo el componente de tokens:
   ```bash
   python manage.py migrate authtoken
   ```
3. (Opcional) Crea un superusuario para el admin:
   ```bash
   python manage.py createsuperuser
   ```

## Endpoints expuestos

- `POST /auth/register/` – Crea un usuario y devuelve `{ token, usuario }`.
- `POST /auth/login/` – Devuelve `{ token, usuario }` con credenciales válidas.
- `GET /auth/me/` – Requiere `Authorization: Token <token>` y devuelve datos del usuario autenticado.

Usa el token en el header `Authorization` para acceder a rutas protegidas desde el frontend.
