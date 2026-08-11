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
    """
    normalized = strip_accents(search_term.strip())
    return [t for t in re.split(r"[\s\-_./,]+", normalized) if t]


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
