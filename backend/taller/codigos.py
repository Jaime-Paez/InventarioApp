"""Codigo sugerido para un repuesto que llego sin codigo nuestro.

Mismo criterio que la sugerencia de Importaciones: si el OEM/referencia ya
esta en un producto de OTRA casa comercial, se toma su codigo, se le quita el
sufijo de esa casa y se le pone el de la casa elegida (p. ej. P1268CL -> P1268PX).
Si el OEM ya es de un producto de la MISMA casa, es ese producto.
"""

import re

from casa_comercial.models import CasaComercial
from core.search_utils import matching_product_ids
from productos.models import OEMProducto, Producto, ProductoAlterno

CODIGO_BASE_LENGTH = 5
LADO_RE = re.compile(r"\s*-\s*([LR])$")


def _split_lado(codigo):
    match = LADO_RE.search(codigo)
    if not match:
        return codigo, ""
    return codigo[: match.start()], f"-{match.group(1)}"


def _producto_dict(producto):
    return {
        "id": producto.id,
        "codigo": producto.codigo,
        "nombre": producto.nombre,
        "precio": str(producto.precio) if producto.precio is not None else None,
        "casas": [casa.nombre for casa in producto.casas_comerciales.all()],
    }


def _normalizar(valor):
    return re.sub(r"[\s\-\.]", "", str(valor or "")).upper()


def sugerir_codigo(referencia, casa_id=None):
    referencia = str(referencia or "").strip()
    resultado = {"codigo_sugerido": "", "fuente": None, "existente": None, "coincidencias": []}
    if not referencia:
        return resultado

    normal = _normalizar(referencia)
    por_oem_ids = set(
        OEMProducto.objects.filter(oem__codigo__iexact=referencia).values_list("producto_id", flat=True)
    )
    if not por_oem_ids and normal:
        for producto_id, codigo in OEMProducto.objects.filter(
            oem__codigo__icontains=normal[:6]
        ).values_list("producto_id", "oem__codigo")[:200]:
            if _normalizar(codigo) == normal:
                por_oem_ids.add(producto_id)
    candidatos = list(
        Producto.objects.filter(id__in=por_oem_ids).prefetch_related("casas_comerciales")
    )
    alternos = list(
        Producto.objects.filter(
            id__in=ProductoAlterno.objects.filter(producto_id__in=por_oem_ids).values("alterno_id")
        )
        .exclude(id__in=por_oem_ids)
        .prefetch_related("casas_comerciales")
    )
    coincidencias = list(
        Producto.objects.filter(id__in=matching_product_ids(referencia)).prefetch_related("casas_comerciales")[:10]
    )
    vistos = set()
    for producto in candidatos + alternos + coincidencias:
        if producto.id not in vistos:
            vistos.add(producto.id)
            resultado["coincidencias"].append(_producto_dict(producto))

    casa = CasaComercial.objects.filter(pk=casa_id).first() if casa_id else None
    if casa is None:
        return resultado
    sufijo = str(casa.codigo or "").strip().upper()

    for producto in candidatos:
        if any(c.id == casa.id for c in producto.casas_comerciales.all()):
            resultado["existente"] = _producto_dict(producto)
            return resultado
    if not sufijo:
        return resultado

    todos = candidatos + alternos
    for producto in todos:
        codigo, lado = _split_lado(str(producto.codigo or "").strip().upper())
        for otra in producto.casas_comerciales.all():
            otro = str(otra.codigo or "").strip().upper()
            if not otro or otro == sufijo:
                continue
            if codigo.endswith(otro) and len(codigo) > len(otro):
                resultado["codigo_sugerido"] = f"{codigo[: -len(otro)]}{sufijo}{lado}"
                resultado["fuente"] = _producto_dict(producto)
                return resultado
    for producto in todos:
        codigo, lado = _split_lado(str(producto.codigo or "").strip().upper())
        if len(codigo) > CODIGO_BASE_LENGTH:
            resultado["codigo_sugerido"] = f"{codigo[:CODIGO_BASE_LENGTH]}{sufijo}{lado}"
            resultado["fuente"] = _producto_dict(producto)
            return resultado
    return resultado
