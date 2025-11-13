from django.db import migrations


PAISES = [
    ("AD", "ANDORRA"),
    ("AE", "UNITED ARAB EMIRATES"),
    ("AF", "AFGHANISTAN"),
    ("AG", "ANTIGUA AND BARBUDA"),
    ("AI", "ANGUILLA"),
    ("AL", "ALBANIA"),
    ("AM", "ARMENIA"),
    ("AN", "DUTCH ANTILLES"),
    ("AO", "ANGOLA"),
    ("AQ", "ANTARCTICA"),
    ("AR", "ARGENTINA"),
    ("AS", "AMERICAN SAMOA"),
    ("AT", "AUSTRIA"),
    ("AU", "AUSTRALIA"),
    ("AW", "ARUBA"),
    ("AX", "ÅLAND ISLANDS"),
    ("AZ", "AZERBAIJAN"),
    ("BA", "BOSNIA AND HERZEGOVINA"),
    ("BB", "BARBADOS"),
    ("BD", "BANGLADESH"),
    ("BE", "BELGIUM"),
    ("BF", "BURKINA FASO"),
    ("BG", "BULGARIA"),
    ("BH", "BAHRAIN"),
    ("BI", "BURUNDI"),
    ("BJ", "BENIN"),
    ("BL", "SAINT BARTHÉLEMY"),
    ("BM", "BERMUDA"),
    ("BN", "BRUNEI"),
    ("BO", "BOLIVIA"),
    ("BQ", "CARIBBEAN NETHERLANDS"),
    ("BR", "BRAZIL"),
    ("BS", "BAHAMAS"),
    ("BT", "BHUTAN"),
    ("BV", "BOUVET ISLAND"),
    ("BW", "BOTSWANA"),
    ("BY", "BELARUS"),
    ("BZ", "BELIZE"),
    ("CA", "CANADA"),
    ("CC", "COCOS (KEELING) ISLANDS"),
    ("CD", "DR CONGO"),
    ("CF", "CENTRAL AFRICAN REPUBLIC"),
    ("CG", "REPUBLIC OF THE CONGO"),
    ("CH", "SWITZERLAND"),
    ("CI", "IVORY COAST"),
    ("CK", "COOK ISLANDS"),
    ("CL", "CHILE"),
    ("CM", "CAMEROON"),
    ("CN", "CHINA"),
    ("CO", "COLOMBIA"),
    ("CR", "COSTA RICA"),
    ("CU", "CUBA"),
    ("CV", "CAPE VERDE"),
    ("CW", "CURAÇAO"),
    ("CX", "CHRISTMAS ISLAND"),
    ("CY", "CYPRUS"),
    ("CZ", "CZECHIA"),
    ("DE", "GERMANY"),
    ("DJ", "DJIBOUTI"),
    ("DK", "DENMARK"),
    ("DM", "DOMINICA"),
    ("DO", "DOMINICAN REPUBLIC"),
    ("DZ", "ALGERIA"),
    ("EC", "ECUADOR"),
    ("EE", "ESTONIA"),
    ("EG", "EGYPT"),
    ("EH", "WESTERN SAHARA"),
    ("ER", "ERITREA"),
    ("ES", "SPAIN"),
    ("ET", "ETHIOPIA"),
    ("EU", "EUROPEAN UNION"),
    ("FI", "FINLAND"),
    ("FJ", "FIJI"),
    ("FK", "FALKLAND ISLANDS"),
    ("FM", "MICRONESIA"),
    ("FO", "FAROE ISLANDS"),
    ("FR", "FRANCE"),
    ("GA", "GABON"),
    ("GB", "UNITED KINGDOM"),
    ("GD", "GRENADA"),
    ("GE", "GEORGIA"),
    ("GF", "FRENCH GUIANA"),
    ("GG", "GUERNSEY"),
    ("GH", "GHANA"),
    ("GI", "GIBRALTAR"),
    ("GL", "GREENLAND"),
    ("GM", "GAMBIA"),
    ("GN", "GUINEA"),
    ("GP", "GUADELOUPE"),
    ("GQ", "EQUATORIAL GUINEA"),
    ("GR", "GREECE"),
    ("GS", "SOUTH GEORGIA"),
    ("GT", "GUATEMALA"),
    ("GU", "GUAM"),
    ("GW", "GUINEA-BISSAU"),
    ("GY", "GUYANA"),
    ("HK", "HONG KONG"),
    ("HM", "HEARD ISLAND AND MCDONALD ISLANDS"),
    ("HN", "HONDURAS"),
    ("HR", "CROATIA"),
    ("HT", "HAITI"),
    ("HU", "HUNGARY"),
    ("ID", "INDONESIA"),
    ("IE", "IRELAND"),
    ("IL", "ISRAEL"),
    ("IM", "ISLE OF MAN"),
    ("IN", "INDIA"),
    ("IO", "BRITISH INDIAN OCEAN TERRITORY"),
    ("IQ", "IRAQ"),
    ("IR", "IRAN"),
    ("IS", "ICELAND"),
    ("IT", "ITALY"),
    ("JE", "JERSEY"),
    ("JM", "JAMAICA"),
    ("JO", "JORDAN"),
    ("JP", "JAPAN"),
    ("KE", "KENYA"),
    ("KG", "KYRGYZSTAN"),
    ("KH", "CAMBODIA"),
    ("KI", "KIRIBATI"),
    ("KM", "COMOROS"),
    ("KN", "SAINT KITTS AND NEVIS"),
    ("KP", "NORTH KOREA"),
    ("KR", "SOUTH KOREA"),
    ("KW", "KUWAIT"),
    ("KY", "CAYMAN ISLANDS"),
    ("KZ", "KAZAKHSTAN"),
    ("LA", "LAOS"),
    ("LB", "LEBANON"),
    ("LC", "SAINT LUCIA"),
    ("LI", "LIECHTENSTEIN"),
    ("LK", "SRI LANKA"),
    ("LR", "LIBERIA"),
    ("LS", "LESOTHO"),
    ("LT", "LITHUANIA"),
    ("LU", "LUXEMBOURG"),
    ("LV", "LATVIA"),
    ("LY", "LIBYA"),
    ("MA", "MOROCCO"),
    ("MC", "MONACO"),
    ("MD", "MOLDOVA"),
    ("ME", "MONTENEGRO"),
    ("MF", "SAINT MARTIN"),
    ("MG", "MADAGASCAR"),
    ("MH", "MARSHALL ISLANDS"),
    ("MK", "NORTH MACEDONIA"),
    ("ML", "MALI"),
    ("MM", "MYANMAR"),
    ("MN", "MONGOLIA"),
    ("MO", "MACAU"),
    ("MP", "NORTHERN MARIANA ISLANDS"),
    ("MQ", "MARTINIQUE"),
    ("MR", "MAURITANIA"),
    ("MS", "MONTSERRAT"),
    ("MT", "MALTA"),
    ("MU", "MAURITIUS"),
    ("MV", "MALDIVES"),
    ("MW", "MALAWI"),
    ("MX", "MEXICO"),
    ("MY", "MALAYSIA"),
    ("MZ", "MOZAMBIQUE"),
    ("NA", "NAMIBIA"),
    ("NC", "NEW CALEDONIA"),
    ("NE", "NIGER"),
    ("NF", "NORFOLK ISLAND"),
    ("NG", "NIGERIA"),
    ("NI", "NICARAGUA"),
    ("NL", "NETHERLANDS"),
    ("NO", "NORWAY"),
    ("NP", "NEPAL"),
    ("NR", "NAURU"),
    ("NU", "NIUE"),
    ("NZ", "NEW ZEALAND"),
    ("OM", "OMAN"),
    ("PA", "PANAMA"),
    ("PE", "PERU"),
    ("PF", "FRENCH POLYNESIA"),
    ("PG", "PAPUA NEW GUINEA"),
    ("PH", "PHILIPPINES"),
    ("PK", "PAKISTAN"),
    ("PL", "POLAND"),
    ("PM", "SAINT PIERRE AND MIQUELON"),
    ("PN", "PITCAIRN ISLANDS"),
    ("PR", "PUERTO RICO"),
    ("PS", "PALESTINE"),
    ("PT", "PORTUGAL"),
    ("PW", "PALAU"),
    ("PY", "PARAGUAY"),
    ("QA", "QATAR"),
    ("RE", "RÉUNION"),
    ("RO", "ROMANIA"),
    ("RS", "SERBIA"),
    ("RU", "RUSSIA"),
    ("RW", "RWANDA"),
    ("SA", "SAUDI ARABIA"),
    ("SB", "SOLOMON ISLANDS"),
    ("SC", "SEYCHELLES"),
    ("SD", "SUDAN"),
    ("SE", "SWEDEN"),
    ("SG", "SINGAPORE"),
    ("SH", "SAINT HELENA, ASCENSION AND TRISTAN DA CUNHA"),
    ("SI", "SLOVENIA"),
    ("SJ", "SVALBARD AND JAN MAYEN"),
    ("SK", "SLOVAKIA"),
    ("SL", "SIERRA LEONE"),
    ("SM", "SAN MARINO"),
    ("SN", "SENEGAL"),
    ("SO", "SOMALIA"),
    ("SR", "SURINAME"),
    ("SS", "SOUTH SUDAN"),
    ("ST", "SÃO TOMÉ AND PRÍNCIPE"),
    ("SV", "EL SALVADOR"),
    ("SX", "SINT MAARTEN"),
    ("SY", "SYRIA"),
    ("SZ", "ESWATINI"),
    ("TC", "TURKS AND CAICOS ISLANDS"),
    ("TD", "CHAD"),
    ("TF", "FRENCH SOUTHERN AND ANTARCTIC LANDS"),
    ("TG", "TOGO"),
    ("TH", "THAILAND"),
    ("TJ", "TAJIKISTAN"),
    ("TK", "TOKELAU"),
    ("TL", "TIMOR-LESTE"),
    ("TM", "TURKMENISTAN"),
    ("TN", "TUNISIA"),
    ("TO", "TONGA"),
    ("TR", "TURKEY"),
    ("TT", "TRINIDAD AND TOBAGO"),
    ("TV", "TUVALU"),
    ("TW", "TAIWAN"),
    ("TZ", "TANZANIA"),
    ("UA", "UKRAINE"),
    ("UG", "UGANDA"),
    ("UM", "UNITED STATES MINOR OUTLYING ISLANDS"),
    ("UN", "DESCONOCIDO"),
    ("US", "UNITED STATES"),
    ("UY", "URUGUAY"),
    ("UZ", "UZBEKISTAN"),
    ("VA", "VATICAN CITY"),
    ("VC", "SAINT VINCENT AND THE GRENADINES"),
    ("VE", "VENEZUELA"),
    ("VG", "BRITISH VIRGIN ISLANDS"),
    ("VI", "UNITED STATES VIRGIN ISLANDS"),
    ("VN", "VIETNAM"),
    ("VU", "VANUATU"),
    ("WF", "WALLIS AND FUTUNA"),
    ("WS", "SAMOA"),
    ("XK", "KOSOVO"),
    ("YE", "YEMEN"),
    ("YT", "MAYOTTE"),
    ("ZA", "SOUTH AFRICA"),
    ("ZM", "ZAMBIA"),
    ("ZW", "ZIMBABWE"),
]


def create_default_types(apps, schema_editor):
    Pais = apps.get_model("tipos", "Pais")
    TipoPago = apps.get_model("tipos", "TipoPago")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    TipoDivision = apps.get_model("tipos", "TipoDivision")

    for codigo, nombre in PAISES:
        Pais.objects.update_or_create(
            codigo_tais=codigo,
            defaults={"nombre": nombre},
        )

    for nombre in [
        "Efectivo",
        "Transferencia",
        "Tarjeta de crédito",
        "Tarjeta de débito",
    ]:
        TipoPago.objects.get_or_create(nombre=nombre)

    for nombre in [
        "enviado",
        "recibido",
        "no llegó",
        "parcialmente recibido",
        "facturado",
        "proformado",
        "vendido",
    ]:
        EstadoMovimiento.objects.get_or_create(nombre=nombre)

    for nombre in [
        "enviado",
        "recibido",
        "no llegó",
        "parcialmente recibido",
    ]:
        EstadoProducto.objects.get_or_create(nombre=nombre)

    tipo_a_subtipos = {
        "salida": ["venta", "traslado", "devolucion"],
        "entrada": ["traslado", "devolucion", "compra local", "importación"],
    }

    for nombre_tipo, subtipos in tipo_a_subtipos.items():
        tipo, _ = TipoMovimiento.objects.get_or_create(nombre=nombre_tipo)
        for nombre_subtipo in subtipos:
            SubTipoMovimiento.objects.get_or_create(
                tipo_movimiento=tipo,
                nombre=nombre_subtipo,
            )

    for nombre in [
        "Estanteria",
        "repisa",
        "mueble",
    ]:
        TipoDivision.objects.get_or_create(nombre=nombre)


def remove_default_types(apps, schema_editor):
    Pais = apps.get_model("tipos", "Pais")
    TipoPago = apps.get_model("tipos", "TipoPago")
    EstadoMovimiento = apps.get_model("tipos", "EstadoMovimiento")
    EstadoProducto = apps.get_model("tipos", "EstadoProducto")
    TipoMovimiento = apps.get_model("tipos", "TipoMovimiento")
    SubTipoMovimiento = apps.get_model("tipos", "SubTipoMovimiento")
    TipoDivision = apps.get_model("tipos", "TipoDivision")

    for codigo, nombre in PAISES:
        Pais.objects.filter(codigo_tais=codigo, nombre=nombre).delete()

    TipoPago.objects.filter(
        nombre__in=[
            "Efectivo",
            "Transferencia",
            "Tarjeta de crédito",
            "Tarjeta de débito",
        ]
    ).delete()

    EstadoMovimiento.objects.filter(
        nombre__in=[
            "enviado",
            "recibido",
            "no llegó",
            "parcialmente recibido",
            "facturado",
            "proformado",
            "vendido",
        ]
    ).delete()

    EstadoProducto.objects.filter(
        nombre__in=[
            "enviado",
            "recibido",
            "no llegó",
            "parcialmente recibido",
        ]
    ).delete()

    tipo_a_subtipos = {
        "salida": ["venta", "traslado", "devolucion"],
        "entrada": ["traslado", "devolucion", "compra local", "importación"],
    }

    for nombre_tipo, subtipos in tipo_a_subtipos.items():
        try:
            tipo = TipoMovimiento.objects.get(nombre=nombre_tipo)
        except TipoMovimiento.DoesNotExist:
            continue
        SubTipoMovimiento.objects.filter(
            tipo_movimiento=tipo,
            nombre__in=subtipos,
        ).delete()
        if not tipo.subtipos.exists():
            tipo.delete()

    TipoDivision.objects.filter(
        nombre__in=[
            "Estanteria",
            "repisa",
            "mueble",
        ]
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("tipos", "0004_remove_estadomovimiento_descripcion_and_more"),
    ]

    operations = [
        migrations.RunPython(create_default_types, remove_default_types),
    ]
