# Imágenes de SKU con `/`: causa, contrato y comprobación

Documento histórico del 29 de octubre de 2026, correspondiente a 4.1.2–4.1.6. **En 4.1.7 la interfaz vuelve al ZIP masivo y deja `/` pendiente; no inicia este recorrido individual.** Consulta el [estado vigente y la comparación de versiones](carga-masiva-rappi-4.1.7.md).

En 4.1.6 se retiró exclusivamente la pantalla de espera de la extensión. Mi Tienda queda visible durante todas las fases; el procesamiento, los clics de creación y sus tiempos no se modificaron. La investigación general de imágenes está en [investigacion-subida-imagenes-rappi.md](investigacion-subida-imagenes-rappi.md). Esta retirada visual no se presenta como una reparación del servicio de imágenes de Rappi.

## Problema reproducido

La versión 4.0.0 (`9944342`) introducía el SKU en el nombre de la entrada del ZIP: `34534/hola.png`. En un ZIP eso es una ruta de carpeta; su nombre final es `hola.png`. `67890/hola.png` tiene el mismo nombre final. Se reprodujo con la función original, JSZip incluido y datos sintéticos. La plantilla de creación conserva el SKU completo en D; no tiene una columna distinta de nombre de imagen ni una hoja de equivalencias de archivos. La asociación usa el SKU prefijado en G y tampoco define nombres de imágenes.

El usuario observó que en Rappi se perdía la parte anterior a `/`. El frontend público envía el ZIP completo a una URL firmada y consulta su procesamiento; el matching ocurre en el servidor. No permite confirmar si ese servidor compara rutas completas, nombres finales o nombres decodificados. Por ello, sustituir `/` por `_`, `%2F` u otro símbolo no constituye una solución demostrada si el SKU del producto sigue siendo el original.

## Vista previa rota observada en 4.1.4

El usuario mostró una imagen rota al iniciar la carga de fotos y después compartió [la URL de esa imagen en Rappi](https://images.rappi.com/products/1793300815577_73087524-8739-488e-8156-1a82ab70a725_11351%2FMoveForward.png). En la revisión de las fotografías fuente consultadas, los PNG tenían 1024 × 1024 píxeles y pesaban menos de 1 MB. Su contenido conservó el SHA-256 al pasar por base64 y reconstruirse como archivo.

Las consultas GET del 29 de octubre sobre la foto reportada dieron estos resultados:

| Ruta consultada | Respuesta observada |
| --- | --- |
| Nombre con `11351%2FMoveForward.png`, sin tamaño | 503 y HTML de error de CloudFront/Lambda |
| El mismo nombre con `?d=250x250` | 200, PNG de 256 × 256 |
| Nombre con `11351%252FMoveForward.png`, sin tamaño | 200, PNG original de 1024 × 1024 y 278.890 bytes |
| Nombre con `%252F` y `?d=250x250` | 502 y HTML de error |
| Nombre con `%2F` y `?d=250x250&panafargo_img_rev=1` | 200, PNG de 256 × 256 |

El PNG original recuperado desde Rappi tiene SHA-256 `2005455833387babeaec75f2d7a318a577c3ac726a89ea0d74dfb46829f0e134`, idéntico al archivo de Shopify. Por tanto, **la fotografía sí se subió y se conservó íntegra en Rappi**. El problema observado estaba en su lectura o visualización. Las diferencias entre rutas son compatibles con una ambigüedad de codificación y un fallo transitorio del CDN; la vista previa respondió correctamente durante la revisión y no puede describirse como un fallo permanente. Estas consultas posteriores tampoco reconstruyen la respuesta exacta del instante de la captura.

El frontend público construye la ruta de imagen concatenando el nombre devuelto por el servidor, sin escaparlo como un segmento de URL. Los archivos preparados en 4.1.4 incluían `%2F` en sus nombres. La corrección usa nombres ASCII sin `%` para eliminar esa ambigüedad. También vuelve a solicitar la vista previa nueva con un número limitado de reintentos: esperar solamente a que una imagen rota tuviera dimensiones no iniciaba otra petición de esa imagen.

## Contrato de carga individual

La [ayuda oficial de creación de productos personalizados](https://rappi-backoffice-web.rappi.com/help/partnercenter/categories/creacion-de-productos/articles/como-crear-masivamente-productos-sin-codigo-de-barras-ean-opcion-personalizados) documenta la carga individual mediante el símbolo «+», además del ZIP. Indica imágenes JPG/PNG, mínimo 600 × 600 y máximo 1 MB; los datos fuente deben cumplir los requisitos del portal. La extensión no amplía artificialmente imágenes pequeñas para simular calidad.

Se leyeron públicamente, sin iniciar sesión ni invocar servicios de escritura:

- [Entrada del catálogo](https://mfe-partner-catalog.rappi.com.co/mfePartnerCatalog.js).
- [Bundle de catálogo `509.575c148061339d05.js`](https://mfe-partner-catalog.rappi.com.co/509.575c148061339d05.js).
- [Bundle de componentes `523.1c7147724926130b.js`](https://mfe-partner-catalog.rappi.com.co/523.1c7147724926130b.js).

El bundle de catálogo permite comprobar:

1. La revisión usa `app-massive-match-suggestions tbody.table-body > tr`.
2. La segunda celda contiene el SKU. Su texto visible puede truncarse, pero `.tooltip.arrow-bottom` conserva el valor completo.
3. La misma fila contiene `app-image-preview input[type="file"]`, oculto, con listener `change`.
4. El handler obtiene el `File`, vacía inmediatamente el input y emite la carga junto con el producto de esa fila.
5. El controlador usa `product.file_id` y `product.id` para identificar el destino de la imagen. El nombre del archivo no decide la publicación a la que pertenece.
6. La respuesta de éxito actualiza `product.image` de ese producto. Tanto éxito como error retiran el loader: su desaparición, por sí sola, no prueba éxito.
7. La lista se pagina inicialmente de diez en diez. `app-pagination a.pagination-next` avanza y `a.pagination-start` vuelve al inicio. Las clases del `li.page` padre indican si están deshabilitados. El buscador de esa pantalla es por nombre/EAN; no se inventó un filtro por SKU.

## Recorrido implementado en 4.1.2–4.1.6, suspendido en la interfaz actual

Para un lote que contenga separadores, `Crear productos` genera el Excel con los SKU completos y un manifiesto de imágenes por SKU, no un ZIP para el importador masivo. Cada imagen corresponde a la foto principal de su publicación. Se usan JPG/PNG; WebP se recodifica a JPEG sin aumentar las dimensiones. Un presupuesto de transporte evita enviar un mensaje excesivamente grande y pide dividir la selección si hace falta.

Desde 4.1.5, el nombre del archivo que se adjunta a cada fila es ASCII y se deriva mediante SHA-256 del SKU completo, con la extensión de su formato. No contiene `/`, `%` ni rutas. Este nombre permite transportar y leer la imagen; la publicación se sigue identificando mediante el SKU completo y los IDs internos de su fila. No se cambia el SKU del Excel, el inventario, los precios ni la asociación para ajustarlos al nombre de la foto.

El mismo botón descarga el Excel y un respaldo ZIP antes de enviar el lote. Para los diseños, el respaldo se construye desde los bytes ya preparados para los controles individuales; no vuelve a consultar las fotos. Para SKU normales, se descarga el mismo ZIP que se enviará al portal. `chrome.downloads.download()` entrega un ID de inicio: la extensión espera el estado real `complete` de ambas descargas mediante eventos y consulta de Chrome. Cancelación, interrupción, borrado o timeout detienen el envío.

Antes de adjuntar la primera imagen se recorren **todas las páginas** y se comprueban SKU exactos, ausencia de duplicados/faltantes/filas ajenas y un único input disponible por fila. Luego se vuelve al inicio y se asignan las imágenes en una segunda pasada, comprobando que el lote y la paginación sigan siendo los mismos. No se modifica ni el SKU de Shopify ni el SKU del Excel de creación.

Tras cada `change`, se espera una URL HTTP(S) nueva en `img.product-image`, una imagen cargada con dimensiones reales y la ausencia del loader. El input vacío no se toma como error ni como confirmación. Si esa URL nueva aún no puede mostrarse, se permiten tres reintentos GET, con esperas de 1, 2 y 4 segundos. Solo se consulta la imagen nueva de la misma fila: no se vuelve a enviar el archivo, no se toma la imagen anterior como éxito y no se pulsa Crear durante los reintentos. Una imagen anterior, URL `data:`, imagen que sigue rota, procesamiento permanente, cambio de filas o timeout detiene el proceso antes de pulsar Crear productos. Cuando todas las imágenes están confirmadas se utiliza el recorrido existente de creación; la asociación final sigue siendo una operación independiente que confirma el usuario.

La carga de las fotos es automática, también cuando se usan los controles individuales de cada fila. Los lotes sin separadores conservan su ZIP automático. El paquete de respaldo para los lotes con `/` se descarga automáticamente y contiene archivos planos seguros y un mapa de SKU completos. Es una copia para conservar: **no debe subirse a Mi Tienda ni requiere extraer o asignar las fotos a mano**.

## Nueva plantilla y descarte del borrador

En 4.1.2, detectar una revisión de imágenes detenía incondicionalmente el envío, incluso cuando era el mismo lote. Ese es el origen del mensaje «Mi Tienda ya tiene un lote en revisión de imágenes»: todavía no se habían enviado las fotos ni pulsado Crear productos.

4.1.3 añadió una reanudación explícita. En 4.1.4 se retira esa acción: el recorrido usa una plantilla nueva después de **Refrescar Rappi**.

La entrada oficial es `/cms/catalog/bulk-creation/home-manual`. El frontend público identifica `/manual/:page` como revisión de un archivo cuyo ID lee desde `ean-match-creation-file-id`. Abrir directamente `/manual/1` sin un ID válido puede mostrar el encabezado de imágenes sin productos. La nueva ruta empieza en la introducción de personalizados y sigue su enlace real hasta el formulario de carga.

Se amplía a 60 segundos la espera de las filas. Si la tabla sigue ausente o vacía, el error distingue esos estados y pide revisar el procesamiento del Excel y refrescar. No se sustituyen los selectores por coincidencias parciales ni se permite crear con cero imágenes confirmadas.

Antes de pulsar Crear se conserva la marca de creación pendiente. Si no se confirma el resultado, impide un reenvío accidental del mismo borrador. Refrescar es el descarte explícito solicitado por el usuario: comprueba que no haya una operación activa, borra solo las marcas del flujo y el ID de borrador, y navega todas las pestañas a una carga nueva. No cancela solicitudes ya enviadas al servidor ni elimina productos creados; si una creación quedó sin confirmación, se debe revisar su resultado antes de crear otro lote.

## Asociación y reinicio

La asociación encuentra cada SKU completo después de retirar una sola vez el prefijo `PANAFARGOSAS_`. Ignora espacios exteriores al comparar, conserva IDs y celdas originales, distingue guiones/mayúsculas/diseños y rechaza duplicados. Las filas ajenas a la selección se excluyen del archivo generado. Sin coincidencias se bloquea la descarga; las coincidencias parciales informan todos los SKU faltantes. Una plantilla dañada o ilegible pide volver a cargar el archivo de Rappi en lugar de usar silenciosamente IDs del respaldo.

`Refrescar Rappi` consulta primero `RAPPI_ESTADO_CARGA` en todas las pestañas y exige que tengan la capacidad actual de reinicio. Luego obtiene la confirmación de `RAPPI_REINICIAR_PREPARACION` y espera la navegación a `home-manual` antes de borrar selección y plantilla locales. Relee los productos de Shopify con las publicaciones desmarcadas. Conserva fuente, inventarios, contexto, equivalencias, tokens, cookies y sesión del usuario. La cola de selección anterior termina antes del borrado para evitar que vuelva a aparecer. Un fallo de confirmación o navegación impide presentar el reinicio como completado.

## Alcance de las pruebas

Las pruebas usan plantillas XLSX reales del repositorio, imágenes y publicaciones sintéticas y un DOM basado en los controles confirmados del frontend oficial. Cubren nombres con el mismo sufijo, SKU largos, dos páginas, reconstrucción de filas, rechazos y confirmación de imagen, además de precios/cantidades separados y limpieza exclusiva de Rappi.

Esto verifica el código local y su contrato de controles. No demuestra una publicación o asociación ejecutada en la cuenta privada de Panafargo. No se subieron imágenes ni productos reales durante el desarrollo. Si Rappi cambia esos controles, el proceso debe detenerse y revisarse; no debe recurrir a coincidencias parciales ni adivinar un SKU.

Al instalar esta versión hay que conservar `shopify/config.js`, recargar la extensión en Chrome y recargar Mi Tienda. Una pestaña abierta con el content script antiguo no debe recibir el lote nuevo de imágenes por SKU.
