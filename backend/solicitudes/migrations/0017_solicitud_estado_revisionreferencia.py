from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("casa_comercial", "0004_casacomercial_remove_unique_codigo"),
        ("solicitudes", "0016_remove_descripcion_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="solicitud",
            name="estado",
            field=models.CharField(
                choices=[
                    ("solicitado", "Solicitado"),
                    ("revisado", "Revisado"),
                    ("archivado", "Archivado"),
                ],
                default="solicitado",
                max_length=20,
            ),
        ),
        migrations.CreateModel(
            name="RevisionReferencia",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "solicitud",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="revisiones",
                        to="solicitudes.solicitud",
                    ),
                ),
                (
                    "casa_comercial",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="revisiones_solicitud",
                        to="casa_comercial.casacomercial",
                    ),
                ),
                ("referencia", models.CharField(blank=True, max_length=255)),
                ("creado_en", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "verbose_name": "Revisión de referencia",
                "verbose_name_plural": "Revisiones de referencia",
                "ordering": ["creado_en"],
            },
        ),
    ]
