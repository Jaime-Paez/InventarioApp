from __future__ import annotations

import re
import unicodedata

from django.db.models import Q
from rest_framework.filters import SearchFilter


def strip_accents(text: str) -> str:
    """Lowercase and remove diacritical marks (accents)."""
    nfkd = unicodedata.normalize("NFD", str(text))
    return "".join(c for c in nfkd if unicodedata.category(c) != "Mn").lower()


def get_search_tokens(search_term: str) -> list[str]:
    """
    Normalize search_term and split into tokens.
    Splits on whitespace and common separators (-, _, ., /, ,).
    Example: "p0849cl 0.3" -> ["p0849cl", "0", "3"]
    Example: "válvula escape" -> ["valvula", "escape"]

    Una palabra que EMPIEZA con guion ("-L", "-la") busca ese sufijo
    literal, con el guion incluido: "c0634 -l" -> ["c0634", "-l"]. Asi
    "-L" encuentra C0634RX-LA pero no C0634RX-RA. Sin esto el guion se
    descartaba y la "l" sola calzaba con casi todo (DELANTERO, -RA...).
    """
    normalized = strip_accents(search_term.strip())
    tokens = []
    for word in normalized.split():
        parts = [t for t in re.split(r"[\-_./,]+", word) if t]
        if not parts:
            continue
        if word.startswith("-"):
            parts[0] = f"-{parts[0]}"
        tokens.extend(parts)
    return tokens


def apply_token_search(queryset, tokens: list[str], fields: list[str]):
    """
    Filter queryset so ALL tokens appear in at least one field via icontains.
    Returns the filtered queryset (call .distinct() after if needed).

    Uses the Postgres "unaccent" lookup (not just Python-side strip_accents
    on the typed term) so a value stored WITH accents, like "Jose Peña",
    still matches a search typed WITHOUT them, like "jose pena" -- the
    common case, since most people don't bother typing tildes/eñes.
    icontains alone is byte-exact and would silently miss that match.
    """
    if not tokens or not fields:
        return queryset

    for token in tokens:
        token_q = None
        for field in fields:
            fq = Q(**{f"{field}__unaccent__icontains": token})
            token_q = fq if token_q is None else token_q | fq
        if token_q:
            queryset = queryset.filter(token_q)

    return queryset


class FuzzyTokenSearchFilter(SearchFilter):
    """
    Replaces DRF's SearchFilter with token-based search.

    - Splits the query on whitespace and separators (-, _, ., /, ,)
    - Strips accents from the search term before tokenizing
    - Each token must match at least one search_field via icontains (OR)
    - All tokens must match (AND)
    """

    def filter_queryset(self, request, queryset, view):
        search_term = request.query_params.get(self.search_param, "").strip()
        if not search_term:
            return queryset

        tokens = get_search_tokens(search_term)
        if not tokens:
            return queryset

        raw_fields = self.get_search_fields(view, request)
        if not raw_fields:
            return queryset

        fields = [f.lstrip("^=@$") for f in raw_fields]
        queryset = apply_token_search(queryset, tokens, fields)
        return queryset.distinct()


# Campos de un producto por los que se busca en TODA la app: codigo, nombre,
# descripcion, referencia (la vieja y las varias) y OEM.
PRODUCT_SEARCH_FIELDS = [
    "codigo",
    "nombre",
    "descripcion",
    "referencia",
    "referencias__valor",
    "oem_productos__oem__codigo",
]


def matching_product_ids(search_term: str):
    """Subconsulta con los ids de productos que calzan con el texto en
    cualquiera de PRODUCT_SEARCH_FIELDS (por palabras, sin tildes)."""
    from productos.models import Producto

    tokens = get_search_tokens(search_term or "")
    if not tokens:
        return Producto.objects.none().values("id")
    return apply_token_search(Producto.objects.all(), tokens, PRODUCT_SEARCH_FIELDS).values("id")


def product_search_text(product_ids) -> dict:
    """{producto_id: "ref1 ref2 oem1 ..."} para que los filtros que buscan
    sobre lo ya cargado en pantalla tambien encuentren por referencia/OEM."""
    from productos.models import OEMProducto, Producto, ProductoReferencia

    ids = sorted({int(pid) for pid in product_ids if pid})
    if not ids:
        return {}
    parts = {pid: [] for pid in ids}
    for pid, referencia in Producto.objects.filter(id__in=ids).values_list("id", "referencia"):
        if referencia:
            parts[pid].append(str(referencia))
    for pid, valor in ProductoReferencia.objects.filter(producto_id__in=ids).values_list("producto_id", "valor"):
        if valor:
            parts[pid].append(str(valor))
    for pid, codigo in OEMProducto.objects.filter(producto_id__in=ids).values_list("producto_id", "oem__codigo"):
        if codigo:
            parts[pid].append(str(codigo))
    return {pid: " ".join(dict.fromkeys(values)) for pid, values in parts.items()}


def attach_product_search(rows, id_key="producto_id", target="producto_busqueda"):
    """Agrega a cada fila (dict) el texto de referencias/OEM de su producto."""
    rows = [row for row in (rows or []) if isinstance(row, dict)]
    texts = product_search_text(row.get(id_key) for row in rows)
    for row in rows:
        row[target] = texts.get(int(row.get(id_key) or 0), "") if row.get(id_key) else ""
    return rows
