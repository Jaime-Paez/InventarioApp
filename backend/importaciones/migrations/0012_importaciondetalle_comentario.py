from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('importaciones', '0011_add_seleccionado_to_detalle'),
    ]

    operations = [
        migrations.AddField(
            model_name='importaciondetalle',
            name='comentario',
            field=models.TextField(blank=True, default=''),
        ),
    ]
