# Imágenes de SKU con `/`: causa, contrato y comprobación

Revisión del 29 de octubre de 2026. Implementación de Panafargo Sync 4.1.3.

## Problema reproducido

La versión 4.0.0 (`9944342`) introducía el SKU en el nombre de la entrada del ZIP: `34534/hola.png`. En un ZIP eso es una ruta de carpeta; su nombre final es `hola.png`. `67890/hola.png` tiene el mismo nombre final. Se reprodujo con la función original, JSZip incluido y datos sintéticos. La plantilla de creación conserva el SKU completo en D; no tiene una columna distinta de nombre de imagen ni una hoja de equivalencias de archivos. La asociación usa el SKU prefijado en G y tampoco define nombres de imágenes.

El usuario observó que en Rappi se perdía la parte anterior a `/`. El frontend público envía el ZIP completo a una URL firmada y consulta su procesamiento; el matching ocurre en el servidor. No permite confirmar si ese servidor compara rutas completas, nombres finales o nombres decodificados. Por ello, sustituir `/` por `_`, `%2F` u otro símbolo no constituye una solución demostrada si el SKU del producto sigue siendo el original.

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

## Solución implementada

Para un lote que contenga separadores, `Preparar en Mi Tienda` genera el Excel con los SKU completos y un manifiesto de imágenes por SKU, no un ZIP para el importador masivo. Cada imagen corresponde a la foto principal de su publicación. Se usan JPG/PNG; WebP se recodifica a JPEG sin aumentar las dimensiones. Un presupuesto de transporte evita enviar un mensaje excesivamente grande y pide dividir la selección si hace falta.

Antes de adjuntar la primera imagen se recorren **todas las páginas** y se comprueban SKU exactos, ausencia de duplicados/faltantes/filas ajenas y un único input disponible por fila. Luego se vuelve al inicio y se asignan las imágenes en una segunda pasada, comprobando que el lote y la paginación sigan siendo los mismos. No se modifica ni el SKU de Shopify ni el SKU del Excel de creación.

Tras cada `change`, se espera una URL HTTP(S) nueva en `img.product-image`, una imagen cargada con dimensiones reales y la ausencia del loader. El input vacío no se toma como error ni como confirmación. Una imagen anterior, URL `data:`, imagen rota, procesamiento permanente, cambio de filas o timeout detiene el proceso antes de pulsar Crear productos. Cuando todas las imágenes están confirmadas se utiliza el recorrido existente de creación; la asociación final sigue siendo una operación independiente que confirma el usuario.

Los lotes sin separadores conservan su ZIP automático. El paquete de respaldo para los lotes con `/` contiene archivos planos seguros y un mapa de SKU completos; **no debe subirse mediante «Cárgalas aquí»**. Es una ayuda para consulta o carga individual si se necesita recuperar el trabajo.

## Retomar una revisión abierta

En 4.1.2, detectar una revisión de imágenes detenía incondicionalmente el envío, incluso cuando era el mismo lote. Ese es el origen del mensaje «Mi Tienda ya tiene un lote en revisión de imágenes»: todavía no se habían enviado las fotos ni pulsado Crear productos.

Desde 4.1.3 se conserva esa parada inicial y se ofrece **Retomar lote abierto** cuando se dispone del manifiesto de imágenes por SKU. El clic explícito usa la misma pestaña y conserva su Excel; no sustituye nombres, descripciones, categorías ni presentación por los del archivo recién generado. El usuario debe revisar esos datos antes de retomarlo. La igualdad de SKU no demuestra que la plantilla tenga los mismos metadatos.

La reanudación exige que la pestaña siga mostrando la revisión de imágenes y ejecuta la misma comprobación global del lote que una carga nueva, antes de adjuntar la primera foto. No crea una plantilla nueva si el portal cambió de pantalla. La oferta se descarta al cambiar la selección, recargar el lote fuente o reiniciar la preparación; una pestaña distinta no puede recibirla. Después de confirmar todas las imágenes se continúa con Crear productos, manteniendo la asociación final manual. Si el portal no confirma que terminó la creación, se debe revisar su estado antes de repetir el envío.

Antes de pulsar Crear se guarda una marca de creación pendiente en la sesión de esa pestaña, ligada al ID de archivo que el frontend de Rappi guarda en `ean-match-creation-file-id`. La marca se retira al confirmar la pantalla de asociación. Si se agota la espera o se recarga Mi Tienda, impide volver a enviar fotos o pulsar Crear para ese mismo archivo. Para comenzar otro lote se exige cargar una plantilla nueva, confirmar su avance y obtener un ID distinto; cambiar solo el ID de `localStorage` desde otra pestaña no basta. Una marca o ID ilegible conserva el bloqueo. Reiniciar la preparación local no borra esa protección.

## Asociación y reinicio

La asociación encuentra cada SKU completo después de retirar una sola vez el prefijo `PANAFARGOSAS_`. Ignora espacios exteriores al comparar, conserva IDs y celdas originales, distingue guiones/mayúsculas/diseños y rechaza duplicados. Las filas ajenas a la selección se excluyen del archivo generado. Sin coincidencias se bloquea la descarga; las coincidencias parciales informan todos los SKU faltantes. Una plantilla dañada o ilegible pide volver a cargar el archivo de Rappi en lugar de usar silenciosamente IDs del respaldo.

`Reiniciar Rappi` borra selección y plantilla local de ese destino, limpia mensajes y relee el lote fuente guardado con las publicaciones desmarcadas. No altera productos, inventarios, contexto, equivalencias ni credenciales de Shopify. La consulta `RAPPI_ESTADO_CARGA` no modifica el portal; si informa una operación activa o no puede confirmar el estado, el reinicio conserva la preparación anterior. La cola de selección anterior termina antes del borrado para evitar que vuelva a aparecer.

## Alcance de las pruebas

Las pruebas usan plantillas XLSX reales del repositorio, imágenes y publicaciones sintéticas y un DOM basado en los controles confirmados del frontend oficial. Cubren nombres con el mismo sufijo, SKU largos, dos páginas, reconstrucción de filas, rechazos y confirmación de imagen, además de precios/cantidades separados y limpieza exclusiva de Rappi.

Esto verifica el código local y su contrato de controles. No demuestra una publicación o asociación ejecutada en la cuenta privada de Panafargo. No se subieron imágenes ni productos reales durante el desarrollo. Si Rappi cambia esos controles, el proceso debe detenerse y revisarse; no debe recurrir a coincidencias parciales ni adivinar un SKU.

Al instalar esta versión hay que conservar `shopify/config.js`, recargar la extensión en Chrome y recargar Mi Tienda. Una pestaña abierta con el content script antiguo no debe recibir el lote nuevo de imágenes por SKU.
