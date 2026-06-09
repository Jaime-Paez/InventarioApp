"""
Sincroniza OEMs y alternos entre productos que comparten el mismo código base
(primeros 5 caracteres del código). Productos cuyo código termina en '-' se
consideran especiales y se excluyen del agrupamiento.

Uso:
    python manage.py sync_grupo_producto              # aplica los cambios
    python manage.py sync_grupo_producto --dry-run    # solo muestra qué haría
    python manage.py sync_grupo_producto --base C0245 # solo ese grupo
"""

from django.core.management.base import BaseCommand

from productos.models import OEM, OEMProducto, Producto, ProductoAlterno


class Command(BaseCommand):
    help = "Sincroniza OEMs y alternos entre productos del mismo grupo base (primeros 5 chars)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Muestra los cambios sin aplicarlos",
        )
        parser.add_argument(
            "--base",
            type=str,
            default=None,
            help="Procesa solo el grupo con este código base (ej: C0245)",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        filtro_base = options["base"]

        if dry_run:
            self.stdout.write(self.style.WARNING("=== MODO DRY-RUN: no se aplica ningún cambio ===\n"))

        # Cargar todos los productos con sus OEMs en una sola consulta
        productos_qs = Producto.objects.prefetch_related("oem_productos__oem").order_by("codigo")

        if filtro_base:
            productos_qs = productos_qs.filter(codigo__startswith=filtro_base)

        # Agrupar por primeros 5 caracteres, excluyendo códigos que terminan en '-'
        grupos: dict[str, list[Producto]] = {}
        excluidos = []

        for producto in productos_qs:
            sufijo = producto.codigo[5:]
            if "-" in sufijo:
                excluidos.append(producto.codigo)
                continue
            base = producto.codigo[:5]
            grupos.setdefault(base, []).append(producto)

        if excluidos:
            self.stdout.write(
                self.style.WARNING(
                    f"Excluidos por terminar en '-': {', '.join(excluidos)}\n"
                )
            )

        total_oems_agregados = 0
        total_alternos_creados = 0
        grupos_procesados = 0

        for base, grupo in sorted(grupos.items()):
            if len(grupo) < 2:
                continue

            grupos_procesados += 1
            codigos_grupo = [p.codigo for p in grupo]
            self.stdout.write(
                self.style.HTTP_INFO(
                    f"\n[{base}] {len(grupo)} productos: {', '.join(codigos_grupo)}"
                )
            )

            # --- OEMs ---
            # Reunir todos los IDs de OEM presentes en cualquier producto del grupo
            oem_ids_por_producto: dict[int, set[int]] = {}
            for producto in grupo:
                oem_ids_por_producto[producto.id] = {
                    rel.oem_id for rel in producto.oem_productos.all()
                }

            todos_los_oem_ids: set[int] = set()
            for ids in oem_ids_por_producto.values():
                todos_los_oem_ids |= ids

            if todos_los_oem_ids:
                oem_codigos_str = ", ".join(
                    OEM.objects.filter(id__in=todos_los_oem_ids)
                    .order_by("codigo")
                    .values_list("codigo", flat=True)
                )
                self.stdout.write(f"  OEMs del grupo: {oem_codigos_str}")
            else:
                self.stdout.write("  OEMs del grupo: ninguno")

            # Asignar OEMs faltantes a cada producto
            for producto in grupo:
                faltantes = todos_los_oem_ids - oem_ids_por_producto[producto.id]
                for oem_id in sorted(faltantes):
                    oem = OEM.objects.get(id=oem_id)
                    self.stdout.write(
                        f"  + OEM '{oem.codigo}' → {producto.codigo}"
                    )
                    if not dry_run:
                        OEMProducto.objects.get_or_create(producto=producto, oem=oem)
                    total_oems_agregados += 1

            # --- Alternos ---
            # Crear relación bidireccional entre todos los pares del grupo
            for i, prod_a in enumerate(grupo):
                for prod_b in grupo[i + 1 :]:
                    # A → B
                    existe_ab = ProductoAlterno.objects.filter(
                        producto=prod_a, alterno=prod_b
                    ).exists()
                    if not existe_ab:
                        self.stdout.write(
                            f"  + Alterno: {prod_a.codigo} → {prod_b.codigo}"
                        )
                        if not dry_run:
                            ProductoAlterno.objects.create(producto=prod_a, alterno=prod_b)
                        total_alternos_creados += 1

                    # B → A (necesario porque get_alternativas solo lee obj.alternativas)
                    existe_ba = ProductoAlterno.objects.filter(
                        producto=prod_b, alterno=prod_a
                    ).exists()
                    if not existe_ba:
                        self.stdout.write(
                            f"  + Alterno: {prod_b.codigo} → {prod_a.codigo}"
                        )
                        if not dry_run:
                            ProductoAlterno.objects.create(producto=prod_b, alterno=prod_a)
                        total_alternos_creados += 1

        modo = "Se agregarían" if dry_run else "Agregados"
        self.stdout.write(
            self.style.SUCCESS(
                f"\n{'='*50}\n"
                f"Grupos procesados : {grupos_procesados}\n"
                f"{modo} OEMs     : {total_oems_agregados}\n"
                f"{modo} alternos : {total_alternos_creados}\n"
            )
        )
