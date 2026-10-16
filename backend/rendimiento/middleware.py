"""Mide cada peticion: tiempo total, consultas a la base y el tiempo que tomaron.

- Resumen por hora y por endpoint (RendimientoRuta): se acumula en memoria y
  se guarda en bloque cada RENDIMIENTO_FLUSH_SEG, asi casi no agrega trabajo.
- Las peticiones de mas de RENDIMIENTO_DETALLE_MS se guardan una por una
  (PeticionLenta) para poder reproducirlas.
- Agrega la cabecera Server-Timing para verlo en las herramientas del navegador.
Cualquier error al medir se ignora: medir nunca debe romper una peticion.
"""

import logging
import random
import re
import threading
import time
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F
from django.db.models.functions import Greatest
from django.utils import timezone

logger = logging.getLogger(__name__)

LENTA_MS = int(getattr(settings, "RENDIMIENTO_LENTA_MS", 500))
DETALLE_MS = int(getattr(settings, "RENDIMIENTO_DETALLE_MS", 1000))
FLUSH_SEG = int(getattr(settings, "RENDIMIENTO_FLUSH_SEG", 60))
RETENCION_DIAS = int(getattr(settings, "RENDIMIENTO_RETENCION_DIAS", 45))
IGNORAR = ("/static/", "/media/", "/ping/", "/admin/")
# Grupo con nombre de las rutas del router: (?P<pk>[^/.]+)
_NAMED_GROUP = re.compile(r"[(][?]P<(\w+)>[^)]*[)]")
_BACKSLASH = chr(92)

_lock = threading.Lock()
_buffer = {}
_last_flush = time.monotonic()


class _QueryCounter:
    def __init__(self):
        self.count = 0
        self.seconds = 0.0

    def __call__(self, execute, sql, params, many, context):
        start = time.perf_counter()
        try:
            return execute(sql, params, many, context)
        finally:
            self.count += 1
            self.seconds += time.perf_counter() - start


def _route(request):
    match = getattr(request, "resolver_match", None)
    route = getattr(match, "route", None) if match else None
    if not route:
        return request.path[:255]
    # Rutas del router en regex: ^movimientos/x/(?P<pk>[^/.]+)/$ -> movimientos/x/<pk>/
    route = _NAMED_GROUP.sub(lambda m: f"<{m.group(1)}>", route)
    route = route.replace("^", "").replace("$", "").replace(_BACKSLASH + ".", ".")
    return route[:255]


def flush(force=False):
    global _last_flush
    with _lock:
        if not force and time.monotonic() - _last_flush < FLUSH_SEG:
            return
        _last_flush = time.monotonic()
        pending = dict(_buffer)
        _buffer.clear()
    if not pending:
        return
    from .models import PeticionLenta, RendimientoRuta

    try:
        with transaction.atomic():
            for (hora, metodo, ruta), s in pending.items():
                row, created = RendimientoRuta.objects.get_or_create(
                    hora=hora, metodo=metodo, ruta=ruta, defaults=s
                )
                if created:
                    continue
                RendimientoRuta.objects.filter(pk=row.pk).update(
                    peticiones=F("peticiones") + s["peticiones"],
                    lentas=F("lentas") + s["lentas"],
                    total_ms=F("total_ms") + s["total_ms"],
                    max_ms=Greatest(F("max_ms"), s["max_ms"]),
                    total_db_ms=F("total_db_ms") + s["total_db_ms"],
                    total_consultas=F("total_consultas") + s["total_consultas"],
                    max_consultas=Greatest(F("max_consultas"), s["max_consultas"]),
                )
        if random.random() < 0.02:
            limite = timezone.now() - timedelta(days=RETENCION_DIAS)
            RendimientoRuta.objects.filter(hora__lt=limite).delete()
            PeticionLenta.objects.filter(fecha__lt=limite).delete()
    except Exception:  # pragma: no cover - medir nunca debe romper nada
        logger.exception("No se pudo guardar el resumen de rendimiento")


class RendimientoMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method == "OPTIONS" or request.path.startswith(IGNORAR):
            return self.get_response(request)
        counter = _QueryCounter()
        start = time.perf_counter()
        with connection.execute_wrapper(counter):
            response = self.get_response(request)
        total_ms = int((time.perf_counter() - start) * 1000)
        db_ms = int(counter.seconds * 1000)
        try:
            response["Server-Timing"] = (
                f'app;dur={total_ms}, db;dur={db_ms};desc="{counter.count} consultas"'
            )
            self._record(request, response, total_ms, db_ms, counter.count)
        except Exception:  # pragma: no cover
            logger.exception("No se pudo medir la peticion")
        return response

    def _record(self, request, response, total_ms, db_ms, queries):
        route = _route(request)
        hora = timezone.now().replace(minute=0, second=0, microsecond=0)
        with _lock:
            s = _buffer.setdefault((hora, request.method, route), {
                "peticiones": 0, "lentas": 0, "total_ms": 0, "max_ms": 0,
                "total_db_ms": 0, "total_consultas": 0, "max_consultas": 0,
            })
            s["peticiones"] += 1
            s["lentas"] += int(total_ms >= LENTA_MS)
            s["total_ms"] += total_ms
            s["max_ms"] = max(s["max_ms"], total_ms)
            s["total_db_ms"] += db_ms
            s["total_consultas"] += queries
            s["max_consultas"] = max(s["max_consultas"], queries)
        if total_ms >= DETALLE_MS:
            from .models import PeticionLenta

            user = getattr(request, "user", None)
            PeticionLenta.objects.create(
                metodo=request.method,
                ruta=route,
                url=request.get_full_path()[:1000],
                estado=int(getattr(response, "status_code", 0) or 0),
                duracion_ms=total_ms,
                db_ms=db_ms,
                consultas=queries,
                usuario=user if getattr(user, "is_authenticated", False) else None,
            )
        flush()
