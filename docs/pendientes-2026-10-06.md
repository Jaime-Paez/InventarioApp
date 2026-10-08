# Pedidos del 6 de octubre de 2026

Lista de cambios pedidos, con cómo se entendió cada uno y su estado. Se actualiza a medida que se van aplicando.

Estados: ⬜ pendiente · 🔄 en curso · ✅ aplicado y subido

## Revisión de inventario

| # | Pedido | Cómo se entendió | Estado |
|---|---|---|---|
| 1 | Mandar faltantes de una percha desde el mapa | En el panel de la percha del **Mapa de conteo**, botón **"Enviar faltantes a revisar"**: elige revisor y hora y le manda solo los productos que faltan contar de esa percha. | ✅ |
| 2 | Botón "No lo encontré" | En la revisión del revisor, botón **"No lo encontré"** para un producto. El administrador lo ve marcado como *No encontrado* y puede **reubicarlo** (indicar en qué ubicación está ahora) o ajustarlo. | ✅ (al reubicar se mueve todo el stock revisado a la nueva ubicación; el total no cambia) |
| 3 | Enviar ahora sin aleatorios | Corregido: la pestaña *Aleatorio* **se mantiene** en "Enviar revisión ahora" (junto a *División específica* y *Lista específica*). Se agregó el check **"Enviar ahora mismo"** junto a la hora: usa la hora actual. | ✅ |
| 4 | Buscar entre productos | En la revisión del revisor, un **buscador** para encontrar un producto (contado o no) y saltar a él. | ✅ |
| 5 | Advertencia "ya fue contado" | Al enviar una revisión (división, subdivisión, lista o faltantes del mapa) que incluye productos que ya se contaron, aviso: *"N productos ya fueron contados, ¿seguro quieres seguir con la revisión?"*. | ✅ (se consideran los contados en los últimos 30 días) |
| 6 | División: contar fila por fila | En revisiones por división, el revisor cuenta **una subdivisión (fila) a la vez**: todos sus productos en una tabla, como en la recepción de importaciones; luego pasa a la siguiente subdivisión. | ✅ |

## Recepción de envíos (importaciones y traslados)

| # | Pedido | Cómo se entendió | Estado |
|---|---|---|---|
| 7 | El check ya suma al inventario | Al marcar el check de un producto, **se recibe en ese momento** (entra al stock en su ubicación o en POR UBICAR). No hace falta terminar todo el envío. | ✅ (además, al abrir el envío se reciben solos los que ya tenían check de antes; lo recibido queda bloqueado) |
| 8 | Barra de progreso | Arriba de la ventana de recepción, una **barra con el avance**: cuántos productos ya se recibieron de cuántos. | ✅ |

## Importaciones (sugerencia / edición)

| # | Pedido | Cómo se entendió | Estado |
|---|---|---|---|
| 9 | Código repetido lleva a su fila | Si en el selector de productos se escribe un código **que ya está en la lista**, en vez de no mostrar nada, **lleva a esa fila** de la tabla (y la resalta). | ✅ |
| 10 | Selector fijo | La fila del **selector de código** queda **fija arriba** de la tabla al desplazarse, para seguir agregando sin volver arriba. | ✅ |

## Entradas

| # | Pedido | Cómo se entendió | Estado |
|---|---|---|---|
| 11 | Tabla "Asignar ubicaciones faltantes" | Corregir la ventana de **ubicaciones faltantes** al crear una entrada: la lista de bodegas se abre encima del texto y tapa la ventana. | ✅ (la lista ahora abre hacia abajo si cabe; no se probó en pantalla) |
| 12 | Traslados desde una compra local | Desde una **compra local**, opción para **repartir** a otras sucursales (crear los traslados) desde la misma compra, como se hace con las importaciones. | ⬜ |

## Pedidos posteriores (8 de octubre)

| # | Pedido | Cómo se entendió | Estado |
|---|---|---|---|
| 13 | Agregar producto encontrado en la revisión | En revisiones por **división o subdivisión**, debajo de cada fila: **"+ Agregar un producto que no está en la lista"** (buscar código y cantidad). Queda guardado y marcado *Agregado*. El administrador lo ve en Diferencias ("encontrado en B05/03") y con **"Mover aquí"** trae esas unidades desde sus otras ubicaciones; si no alcanzan, la diferencia se suma como ajuste. | ✅ |
