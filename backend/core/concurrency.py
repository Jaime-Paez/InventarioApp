from __future__ import annotations

from django.db import connection


def acquire_sequence_lock(*key_parts) -> None:
    """
    Adquiere un advisory lock de Postgres con alcance a la transaccion actual,
    identificado por key_parts (p. ej. el modelo y el prefijo del codigo).

    Debe llamarse dentro de un transaction.atomic() que tambien haga el INSERT
    que reserva el numero calculado despues de este lock: el lock se libera
    recien al hacer commit/rollback de esa transaccion, asi que dos requests
    concurrentes pidiendo un codigo para el mismo prefijo quedan serializados
    -- el segundo espera a que el primero termine (y su fila ya sea visible)
    antes de calcular su propio "siguiente numero". Sin esto, dos requests
    pueden leer el mismo maximo actual y generar el mismo codigo, chocando
    contra la restriccion unique al insertar (o, si el campo no es unique,
    dejando dos filas con el mismo codigo silenciosamente).
    """
    lock_key = ":".join(str(part) for part in key_parts)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [lock_key])
