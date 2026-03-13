from django.db import migrations, models
import django.db.models.deletion


def _normalize_name(value):
    return " ".join(str(value or "").strip().lower().split())


def _build_unique_code(marca_manager, used_codes):
    index = 1
    while True:
        candidate = f"SLM{index:04d}"
        if candidate not in used_codes and not marca_manager.filter(codigo__iexact=candidate).exists():
            used_codes.add(candidate)
            return candidate
        index += 1


def migrate_producto_solicitado_marcas(apps, schema_editor):
    Marca = apps.get_model("marcas", "Marca")
    ProductoSolicitado = apps.get_model("solicitudes", "ProductoSolicitado")
    db_alias = schema_editor.connection.alias

    marca_manager = Marca.objects.using(db_alias)
    producto_manager = ProductoSolicitado.objects.using(db_alias)

    marcas_by_name = {}
    used_codes = set()

    for marca in marca_manager.all().only("id", "nombre", "codigo").iterator():
        normalized_name = _normalize_name(getattr(marca, "nombre", ""))
        if normalized_name and normalized_name not in marcas_by_name:
            marcas_by_name[normalized_name] = marca
        codigo = str(getattr(marca, "codigo", "") or "").strip().upper()
        if codigo:
            used_codes.add(codigo)

    default_key = _normalize_name("Sin marca")
    default_marca = marcas_by_name.get(default_key)
    if default_marca is None:
        default_code = "SIN"
        if default_code in used_codes or marca_manager.filter(codigo__iexact=default_code).exists():
            default_code = _build_unique_code(marca_manager, used_codes)
        else:
            used_codes.add(default_code)
        default_marca = marca_manager.create(
            nombre="Sin marca",
            codigo=default_code,
            descripcion="Marca por defecto para solicitudes migradas.",
        )
        marcas_by_name[default_key] = default_marca

    for producto in producto_manager.all().iterator():
        legacy_name = str(getattr(producto, "marca", "") or "").strip()
        normalized_name = _normalize_name(legacy_name)

        if not normalized_name:
            marca = default_marca
        else:
            marca = marcas_by_name.get(normalized_name)
            if marca is None:
                marca = marca_manager.create(
                    nombre=legacy_name,
                    codigo=_build_unique_code(marca_manager, used_codes),
                    descripcion="Marca migrada automaticamente desde solicitudes.",
                )
                marcas_by_name[normalized_name] = marca

        producto.marca_rel_id = marca.id
        producto.save(update_fields=["marca_rel"])


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("marcas", "0003_add_codigo_and_fields"),
        ("solicitudes", "0009_regroup_solicitud_grupos"),
    ]

    operations = [
        migrations.AddField(
            model_name="productosolicitado",
            name="marca_rel",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="productos_solicitados",
                to="marcas.marca",
            ),
        ),
        migrations.RunPython(
            migrate_producto_solicitado_marcas,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.RemoveField(
            model_name="productosolicitado",
            name="marca",
        ),
        migrations.RenameField(
            model_name="productosolicitado",
            old_name="marca_rel",
            new_name="marca",
        ),
        migrations.AlterField(
            model_name="productosolicitado",
            name="marca",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="productos_solicitados",
                to="marcas.marca",
            ),
        ),
    ]
