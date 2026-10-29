# Panafargo Sync 4.1.2

Extensión de Chrome para consultar publicaciones de Shopify, revisar sus datos y preparar su creación y asociación en Rappi. Conserva el trabajo al cerrar o recargar la ventana; **Nuevo lote** lo reinicia explícitamente.

## SKU base y publicación

| SKU completo de Shopify | Producto base | Identidad para Rappi e inventario |
| --- | --- | --- |
| `11351/MoveForward` | `11351` | `11351/MoveForward` |
| `11351/YourDream` | `11351` | `11351/YourDream` |
| `10498-1/Femenino` | `10498-1` | `10498-1/Femenino` |
| `10498-1/Masculino` | `10498-1` | `10498-1/Masculino` |

Solo el texto anterior a la primera `/` se usa para comparar y contar productos base. Los guiones se conservan: `10498` y `10498-1` son referencias diferentes. Para almacenar, seleccionar, exportar y asociar se usa siempre el **SKU completo**.

- Una búsqueda por base encuentra todas sus publicaciones, recorriendo las páginas de Shopify y descartando coincidencias parciales.
- Una búsqueda por SKU completo conserva únicamente esa publicación.
- Cada base se consulta una vez por proceso, aunque se peguen varios de sus diseños.
- El límite es de **10 bases**, que pueden representar **14 o más publicaciones**. El sistema no recorta silenciosamente las líneas.
- Si el mismo SKU completo aparece en variantes distintas de Shopify, queda bloqueado para resolver la ambigüedad; no se suman inventarios ni se elige uno al azar.

## Instalación

1. Crea `shopify/config.js` a partir de `shopify/config.example.js` y configura la tienda y la aplicación de Shopify. Este archivo está excluido de Git; no publiques credenciales.
2. La aplicación de Shopify necesita estar instalada en esa tienda y tener habilitada la lectura de productos. El módulo obtiene y almacena temporalmente el access token mediante `client_credentials`.
3. En Chrome, abre `chrome://extensions`, activa el modo desarrollador y carga esta carpeta como extensión descomprimida.
4. Abre Panafargo Sync desde su icono. Las bibliotecas de Excel y ZIP ya están incluidas; la extensión no necesita una instalación con npm.

Al actualizar desde 4.0.0, conserva tu `shopify/config.js`, recarga la extensión en `chrome://extensions` y recarga también Mi Tienda (F5). La cabecera de la ventana permite comprobar la versión instalada. La carga por SKU comprueba que la pestaña tenga activo el código nuevo antes de enviar el lote.

## Flujo para el usuario

### 1. Revisar productos

Pega los códigos y pulsa **Buscar y validar**. Cada publicación tiene su tarjeta con imagen, SKU completo, base, existencias, disponibilidad para Rappi y los datos pendientes. La foto propia de la variante tiene prioridad sobre la imagen general del producto.

El resumen distingue productos base, publicaciones, listas y pendientes. Una base con diseños publicados no se marca como faltante por no existir un SKU idéntico a la base. **Reintentar pendientes** vuelve a consultar solo lo que necesita revisión. El reporte CSV es opcional: no se descarga un archivo cada vez que buscas.

### 2. Preparar Rappi

Las publicaciones listas se seleccionan automáticamente y las elecciones se conservan por SKU completo. Puedes desmarcar las que no quieres incluir. Los bloqueos siguen visibles y no pueden seleccionarse.

- **Descargar lote e imágenes:** genera un Excel de creación y un solo paquete de imágenes.
- **Preparar en Mi Tienda:** encuentra o abre la pestaña de Rappi. Debes tener tu sesión iniciada. Los lotes sin separadores conservan el ZIP automático; si hay SKU con `/`, las imágenes del lote se asignan automáticamente a sus filas por SKU completo. Solo después de confirmar las imágenes se continúa con la creación, sin confirmar la asociación final.
- Si Mi Tienda ya está revisando imágenes de un lote anterior, la extensión se detiene. No aplica un ZIP nuevo sobre una plantilla que podría pertenecer a otro lote.
- No se aceptan envíos simultáneos mientras se está procesando un lote o esperando el reintento de Rappi.
- Durante el procesamiento y la creación, una pantalla de espera opaca cubre la pestaña completa. Si aparece el fallo temporal de «página no encontrada», muestra la espera antes de la actualización automática. Esa barra representa el tiempo de espera, no una confirmación de productos creados; si falla la recuperación, se retira para permitir revisar el error.
- **Reiniciar Rappi**, arriba del paso 2, borra selección, mensajes y la plantilla de asociación guardada, y vuelve a leer el lote fuente actual con todas las publicaciones desmarcadas. Conserva productos, conteos, contexto de búsqueda, equivalencias y credenciales de Shopify. No recarga ni modifica Mi Tienda. Si hay una operación activa o la pestaña no confirma su estado, conserva la preparación anterior.

### Imágenes de SKU con `/`

El Excel conserva `11351/MoveForward` tal cual. En cambio, `/` es un separador de carpetas dentro de un ZIP: `34534/hola.jpg` tiene como nombre final `hola.jpg`. **No se inventa que Rappi decodifique un nombre alternativo.**

El frontend público de Mi Tienda permite adjuntar una imagen directamente a una fila, usando sus identificadores internos de producto y archivo. La extensión utiliza ese control para los lotes con `/`: primero recorre todas las páginas y comprueba que cada SKU completo aparezca exactamente una vez; después asigna la imagen principal de cada publicación en una segunda pasada. Comprueba una URL de imagen nueva y cargada y la ausencia del indicador de procesamiento. No usa el nombre del archivo para decidir a qué producto pertenece.

Si falta un SKU, hay duplicados, cambian las filas, falla una imagen o no se puede confirmar su carga, no pulsa **Crear productos**. La cabecera muestra cuántas imágenes se han confirmado. La foto de cada diseño procede de su publicación de Shopify; no se suman ni comparten existencias. WebP se recodifica a JPEG para este recorrido; los adjuntos son JPG/PNG de hasta 1 MB.

**Descargar lote y respaldo de imágenes** sigue disponible como alternativa local, con nombres seguros y mapas CSV/JSON que conservan el SKU completo. **No subas ese ZIP de respaldo mediante «Cárgalas aquí».** Extráelo si necesitas cargar imágenes individualmente. Las fuentes del contrato, los selectores y los límites de comprobación están en [docs/rappi-imagenes-por-sku.md](docs/rappi-imagenes-por-sku.md). Las pruebas locales y el código público no demuestran que una cuenta privada haya publicado productos.

### 3. Asociar

Selecciona la plantilla `.xlsx` que Rappi envía para el lote; se valida y guarda automáticamente, sin un botón Guardar. Una nueva plantilla válida reemplaza la anterior, incluidos su archivo y nombre. Si no es válida, se conserva la plantilla actual. El nombre vigente aparece en pantalla y se recupera al volver a abrir la extensión. También puedes volver a seleccionar un archivo actualizado que conserve el mismo nombre.

**Descargar precios y existencias** completa únicamente las filas seleccionadas, encontrándolas por SKU completo en la columna G con el prefijo `PANAFARGOSAS_`.

- K: precio calculado.
- N: unidades disponibles después de la reserva.
- Los identificadores, descripciones, descuento y disponibilidad de las filas seleccionadas se conservan.
- Las filas ajenas al lote se eliminan del archivo generado para evitar actualizar otros productos.
- No se sustituye un diseño ausente por su base. Se informa cada SKU completo que no tenga fila en la plantilla.
- Los espacios exteriores del Excel se ignoran al buscar, conservando las celdas e identificadores originales. Los SKU duplicados se rechazan. Una plantilla guardada dañada no se cambia silenciosamente por otra con identificadores distintos.

Sube el archivo generado en Mi Tienda, revísalo y confirma allí la asociación. La extensión no pulsa ese botón final ni recibe tu contraseña de Rappi.

## Inventario y precio

### Existencias

El inventario se lee de `inventoryQuantity` de la variante exacta de Shopify. Para los SKU con `/`, ese dato es el **conteo manual registrado en Shopify por publicación**. No se toma de Webcol, de un archivo de productos ni del inventario de la base, y no se distribuye una cantidad compartida entre diseños.

Se mantiene la reserva existente: menos de 50 unidades → `floor(inventario / 3)`; desde 50 → `floor(inventario / 2)`. Por ejemplo, dos diseños con 3 y 6 unidades producen 1 y 2 unidades para Rappi, respectivamente. El redondeo hacia abajo corresponde a cantidades de inventario, no al precio.

### Precio

P es el precio normal de Shopify: `compareAtPrice` si supera `price`; en los demás casos, `price`.

- Hasta **$444.500 inclusive**: `(P × 0,80) ÷ 0,70`.
- Por encima de **$444.500**: `(P × 0,90) ÷ 0,70`.
- Solo el resultado final se redondea **hacia arriba** al siguiente múltiplo de $100, conservando los múltiplos exactos. Se usa aritmética entera.

$350.000 produce $400.000; $516.700 produce $664.400. Al preparar el lote se recalcula el precio para no exportar un valor anterior guardado. El cálculo local no publica cambios sobre el catálogo existente de Rappi.

## Verificación

Con Node.js 24, desde la raíz:

```bash
node --test tests/*.test.mjs
```

Las pruebas usan datos simulados y las bibliotecas y plantillas reales del repositorio: SKU, paginación, conteos, inventario separado, reserva, precios, imágenes, Excel y límites de automatización. No necesitan credenciales ni crean productos en Shopify o Rappi. La comprobación del portal real requiere una sesión autorizada y un lote de prueba revisado por el usuario.

## Mantenimiento y expansión

`utils/sku.js` y `utils/lote.js` contienen identidad, agrupación y coordinación reutilizables. Shopify es la fuente; `rappi/` conserva las categorías, reserva, formato Excel y automatización específicos del destino. La estructura y los siguientes pasos para Mercado Libre están descritos en [docs/flujo-y-expansion.md](docs/flujo-y-expansion.md).

El catálogo conserva las 987 categorías y equivalencias de peso utilizadas. Marca y EAN quedan vacíos en la plantilla de creación conforme a las reglas existentes. Peso ausente, inventario inválido, imagen ausente o SKU ambiguo bloquean la publicación. Si Rappi cambia sus pantallas o plantillas, deben comprobarse contra el portal real antes de modificar selectores o formatos.
