"""`migrate` para el build de Render sin trabar la app que sigue en linea.

Durante el build el servidor viejo sigue atendiendo. Un ALTER TABLE sobre una
tabla en uso (por ejemplo el ReminderState, que el sondeo bloquea unos
segundos) se queda esperando el bloqueo y, mientras espera, bloquea TODAS las
consultas a esa tabla: la app parecia caida y a los 20 s (statement_timeout)
el build fallaba.

Aqui cada migracion espera el bloqueo como mucho `--lock-timeout` segundos y,
si no lo consigue, se reintenta tras una pausa. Las migraciones en Postgres
son atomicas, asi que un intento cortado no deja nada a medias. Ademas se
quita el statement_timeout de 20 s (una migracion de datos puede tardar mas).
"""

import time

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import OperationalError, connection

LOCK_NOT_AVAILABLE = "55P03"


class Command(BaseCommand):
    help = "Aplica migraciones con lock_timeout corto y reintentos (build de Render)."

    def add_arguments(self, parser):
        parser.add_argument("--lock-timeout", type=int, default=5)
        parser.add_argument("--intentos", type=int, default=8)
        parser.add_argument("--pausa", type=int, default=10)

    def handle(self, *args, **options):
        lock_timeout = max(1, int(options["lock_timeout"]))
        attempts = max(1, int(options["intentos"]))
        pause = max(1, int(options["pausa"]))

        for attempt in range(1, attempts + 1):
            try:
                if connection.vendor == "postgresql":
                    with connection.cursor() as cursor:
                        cursor.execute(f"SET lock_timeout = '{lock_timeout}s'")
                        cursor.execute("SET statement_timeout = 0")
                call_command("migrate", interactive=False, verbosity=1)
                return
            except OperationalError as exc:
                cause = getattr(exc, "__cause__", None)
                if getattr(cause, "pgcode", None) != LOCK_NOT_AVAILABLE or attempt == attempts:
                    raise
                self.stdout.write(
                    f"Tabla ocupada (intento {attempt}/{attempts}); se reintenta en {pause} s..."
                )
                connection.close()
                time.sleep(pause)
        raise CommandError("No se pudieron aplicar las migraciones.")
