import random
import string
import unicodedata

from rest_framework import serializers

from .models import CasaComercial
from tipos.models import Pais
from tipos.serializers import PaisSerializer

VOWELS = {"A", "E", "I", "O", "U"}
ALPHABET = tuple(string.ascii_uppercase)
RANDOM_GENERATOR = random.SystemRandom()


def _normalize_letters(value):
    normalized = unicodedata.normalize("NFD", str(value or ""))
    normalized = "".join(
        char for char in normalized if unicodedata.category(char) != "Mn"
    )
    return [char for char in normalized.upper() if "A" <= char <= "Z"]


def _unique_in_order(items):
    unique_items = []
    seen = set()
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        unique_items.append(item)
    return unique_items


def _build_base_code(nombre):
    letters = _normalize_letters(nombre)
    consonants = [char for char in letters if char not in VOWELS]
    vowels = [char for char in letters if char in VOWELS]

    code_chars = list(consonants[:3])
    vowel_index = 0
    while len(code_chars) < 3 and vowel_index < len(vowels):
        code_chars.append(vowels[vowel_index])
        vowel_index += 1

    while len(code_chars) < 3:
        code_chars.append(RANDOM_GENERATOR.choice(ALPHABET))

    return "".join(code_chars[:3])


def _codigo_exists(codigo):
    return CasaComercial.objects.filter(
        codigo__iexact=str(codigo or "").strip()
    ).exists()


def generate_unique_casa_code(nombre):
    base = _build_base_code(nombre)
    if not base:
        base = "".join(RANDOM_GENERATOR.choice(ALPHABET) for _ in range(3))

    if not _codigo_exists(base):
        return base

    letters = _normalize_letters(nombre)
    consonants = [char for char in letters if char not in VOWELS]
    vowels = [char for char in letters if char in VOWELS]
    pool = _unique_in_order([*vowels, *consonants, *ALPHABET])

    for third in pool:
        candidate = f"{base[:2]}{third}"
        if not _codigo_exists(candidate):
            return candidate

    for second in pool:
        for third in pool:
            candidate = f"{base[:1]}{second}{third}"
            if not _codigo_exists(candidate):
                return candidate

    for _ in range(200):
        candidate = "".join(RANDOM_GENERATOR.choice(ALPHABET) for _ in range(3))
        if not _codigo_exists(candidate):
            return candidate

    raise serializers.ValidationError(
        {"codigo": "No se pudo generar un codigo unico para la casa comercial."}
    )


class CasaComercialSerializer(serializers.ModelSerializer):
    pais = PaisSerializer(read_only=True)
    pais_id = serializers.PrimaryKeyRelatedField(
        source="pais",
        queryset=Pais.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )

    class Meta:
        model = CasaComercial
        fields = [
            "id",
            "codigo",
            "nombre",
            "descripcion",
            "telefono",
            "correo",
            "pais",
            "pais_id",
        ]
        extra_kwargs = {
            "codigo": {"required": False, "allow_blank": True},
        }

    def validate_codigo(self, value):
        return str(value or "").strip().upper()

    def create(self, validated_data):
        validated_data.pop("codigo", None)
        validated_data["codigo"] = generate_unique_casa_code(
            validated_data.get("nombre")
        )
        return super().create(validated_data)
