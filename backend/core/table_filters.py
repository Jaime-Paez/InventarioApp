from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping

from django.db.models import Q
from django.utils.dateparse import parse_date

TEXT_LOOKUPS = {
    "contains": "icontains",
    "startswith": "istartswith",
    "endswith": "iendswith",
    "equals": "iexact",
    "notcontains": "icontains",
    "notequals": "iexact",
}
NUMBER_LOOKUPS = {
    "equals": "exact",
    "notequals": "exact",
    "lt": "lt",
    "lte": "lte",
    "gt": "gt",
    "gte": "gte",
}
DATE_LOOKUPS = {
    "dateis": "exact",
    "dateisnot": "exact",
    "datebefore": "lt",
    "dateafter": "gt",
    "equals": "exact",
    "notequals": "exact",
    "lt": "lt",
    "lte": "lte",
    "gt": "gt",
    "gte": "gte",
}
NEGATED_MODES = {"notcontains", "notequals", "dateisnot"}


def parse_column_filters(raw_value: Any) -> dict[str, dict[str, Any]]:
    if not raw_value:
        return {}

    parsed: Any
    if isinstance(raw_value, Mapping):
        parsed = raw_value
    else:
        try:
            parsed = json.loads(raw_value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}

    if not isinstance(parsed, Mapping):
        return {}

    result: dict[str, dict[str, Any]] = {}
    for field, raw_meta in parsed.items():
        if not isinstance(field, str) or not isinstance(raw_meta, Mapping):
            continue

        operator = str(raw_meta.get("operator") or "AND").upper()
        constraints = raw_meta.get("constraints")
        normalized_constraints: list[dict[str, Any]] = []

        if isinstance(constraints, list):
            for raw_constraint in constraints:
                if not isinstance(raw_constraint, Mapping):
                    continue
                value = _normalize_filter_value(raw_constraint.get("value"))
                if value is None:
                    continue
                normalized_constraints.append(
                    {
                        "value": value,
                        "match_mode": str(raw_constraint.get("matchMode") or "").strip(),
                    }
                )
        else:
            value = _normalize_filter_value(raw_meta.get("value"))
            if value is not None:
                normalized_constraints.append(
                    {
                        "value": value,
                        "match_mode": str(raw_meta.get("matchMode") or "").strip(),
                    }
                )

        if normalized_constraints:
            result[field] = {
                "operator": "OR" if operator == "OR" else "AND",
                "constraints": normalized_constraints,
            }

    return result


def apply_column_filters(
    queryset,
    column_filters: Mapping[str, Mapping[str, Any]],
    field_map: Mapping[str, Any],
):
    if not column_filters:
        return queryset

    for field_name, meta in column_filters.items():
        if not isinstance(meta, Mapping):
            continue

        mapping = field_map.get(field_name)
        if not mapping:
            continue

        if isinstance(mapping, str):
            lookup_path = mapping
            value_type = "text"
        else:
            lookup_path = str(mapping.get("lookup") or "").strip()
            value_type = str(mapping.get("type") or "text").strip().lower()

        if not lookup_path:
            continue

        filter_q = _build_field_q(lookup_path, meta, value_type=value_type)
        if filter_q is not None:
            queryset = queryset.filter(filter_q)

    return queryset


def _build_field_q(lookup_path: str, meta: Mapping[str, Any], value_type: str = "text"):
    operator = str(meta.get("operator") or "AND").upper()
    constraints = meta.get("constraints")
    if not isinstance(constraints, list):
        return None

    compound_q: Q | None = None
    for constraint in constraints:
        if not isinstance(constraint, Mapping):
            continue
        constraint_q = _build_constraint_q(
            lookup_path=lookup_path,
            value=constraint.get("value"),
            match_mode=constraint.get("match_mode"),
            value_type=value_type,
        )
        if constraint_q is None:
            continue
        if compound_q is None:
            compound_q = constraint_q
        elif operator == "OR":
            compound_q |= constraint_q
        else:
            compound_q &= constraint_q

    return compound_q


def _build_constraint_q(lookup_path: str, value: Any, match_mode: Any, value_type: str = "text"):
    mode = str(match_mode or "contains").strip().lower()

    if value_type == "number":
        return _build_number_q(lookup_path, value, mode)
    if value_type == "date":
        return _build_date_q(lookup_path, value, mode)
    return _build_text_q(lookup_path, value, mode)


def _build_text_q(lookup_path: str, value: Any, mode: str):
    if mode == "in":
        values = _normalize_iterable(value, cast_as_string=True)
        if not values:
            return None
        query = Q(**{f"{lookup_path}__in": values})
        return ~query if mode in NEGATED_MODES else query

    lookup = TEXT_LOOKUPS.get(mode, "icontains")
    text_value = str(value).strip()
    if not text_value:
        return None
    query = Q(**{f"{lookup_path}__{lookup}": text_value})
    return ~query if mode in NEGATED_MODES else query


def _build_number_q(lookup_path: str, value: Any, mode: str):
    if mode == "between":
        values = _normalize_iterable(value, cast_as_decimal=True)
        if len(values) < 2:
            return None
        min_value = values[0]
        max_value = values[1]
        return Q(**{f"{lookup_path}__gte": min_value, f"{lookup_path}__lte": max_value})

    if mode == "in":
        values = _normalize_iterable(value, cast_as_decimal=True)
        if not values:
            return None
        return Q(**{f"{lookup_path}__in": values})

    lookup = NUMBER_LOOKUPS.get(mode, "exact")
    decimal_value = _to_decimal(value)
    if decimal_value is None:
        return None
    query = Q(**{f"{lookup_path}__{lookup}": decimal_value})
    return ~query if mode in NEGATED_MODES else query


def _build_date_q(lookup_path: str, value: Any, mode: str):
    if mode == "between":
        values = _normalize_iterable(value, cast_as_date=True)
        if len(values) < 2:
            return None
        start_date = values[0]
        end_date = values[1]
        return Q(**{f"{lookup_path}__gte": start_date, f"{lookup_path}__lte": end_date})

    if mode == "in":
        values = _normalize_iterable(value, cast_as_date=True)
        if not values:
            return None
        return Q(**{f"{lookup_path}__in": values})

    lookup = DATE_LOOKUPS.get(mode, "exact")
    parsed_date = parse_date(str(value).strip())
    if parsed_date is None:
        return None
    query = Q(**{f"{lookup_path}__{lookup}": parsed_date})
    return ~query if mode in NEGATED_MODES else query


def _normalize_filter_value(value: Any):
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, (list, tuple)):
        normalized_list = []
        for item in value:
            normalized = _normalize_filter_value(item)
            if normalized is not None:
                normalized_list.append(normalized)
        return normalized_list or None
    return value


def _normalize_iterable(
    value: Any,
    *,
    cast_as_decimal: bool = False,
    cast_as_date: bool = False,
    cast_as_string: bool = False,
):
    if isinstance(value, (list, tuple)):
        values = list(value)
    else:
        raw_text = str(value or "").strip()
        if not raw_text:
            return []
        values = [chunk.strip() for chunk in raw_text.split(",")]

    normalized = []
    for item in values:
        if item in ("", None):
            continue
        if cast_as_decimal:
            decimal_value = _to_decimal(item)
            if decimal_value is not None:
                normalized.append(decimal_value)
            continue
        if cast_as_date:
            date_value = parse_date(str(item).strip())
            if date_value is not None:
                normalized.append(date_value)
            continue
        if cast_as_string:
            text = str(item).strip()
            if text:
                normalized.append(text)
            continue
        normalized.append(item)
    return normalized


def _to_decimal(value: Any):
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        return None
