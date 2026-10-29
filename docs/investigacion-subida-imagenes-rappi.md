# Investigación general de subida de imágenes a Rappi

Revisión del 29 de octubre de 2026. Base investigada: 4.1.5 (`3ec6505`). Cambio de 4.1.6: retirar la pantalla superpuesta de Panafargo Sync para observar Mi Tienda. La lógica de creación se conserva; esta investigación no modifica los métodos de subida ni declara reparado el servicio de imágenes.

**Actualización 4.1.7:** se recupera el ZIP masivo, se exigen todas las secundarias, se completa la galería paginada, se rechazan respuestas sin firma de imagen y el detector observa errores visibles del panel actual antes del éxito. El recorrido individual queda fuera de la interfaz y `/` pendiente. La tabla siguiente conserva los hallazgos sobre 4.1.5; no debe interpretarse como una descripción de todos los comportamientos actuales. Consulta [carga-masiva-rappi-4.1.7.md](carga-masiva-rappi-4.1.7.md).

## Qué se conservó y qué queda visible

`continuarYCcrearProductos` mantiene exactamente el mismo cuerpo. Se conservan también las esperas, el bloqueo de envíos simultáneos, las marcas, el reintento de recarga de 60 segundos y los mensajes de respuesta. Se retiraron únicamente la capa opaca, las barras, sus animaciones y las llamadas que actualizaban esos elementos.

Las pruebas diferenciales ejecutan los scripts anterior y actual sobre el mismo DOM y comparan envíos, clics, marcas y resultados. Mi Tienda y sus avisos permanecen visibles durante la subida, el procesamiento, la espera de recarga y la creación.

## El proceso real de imágenes tiene varias etapas

El recorrido masivo documentado en el frontend de Rappi es:

1. La extensión obtiene y prepara las fotos de Shopify, genera el ZIP y conserva la copia local.
2. Mi Tienda solicita una URL firmada para el archivo y el lote actuales.
3. Al seleccionar el ZIP, Mi Tienda envía su contenido a S3. Llegar al 100 % de transferencia termina esta etapa, no todas las siguientes.
4. Rappi consulta el procesamiento del archivo: descargar, descomprimir, subir imágenes y asociarlas a productos.
5. La respuesta de procesamiento informa la etapa, contadores y, cuando corresponde, el resultado o error.
6. La lista de productos se refresca para mostrar sus imágenes. La lectura de la imagen desde el CDN es otra petición y puede fallar independientemente del almacenamiento.

La solicitud oficial de URL firmada del ZIP usa `mode=by_orphans` y su consulta de progreso ya tiene la ruta `/orphans/{fileId}/images-progress`. No se encontró un modo incorrecto en esas dos operaciones; el defecto de modo descrito abajo pertenece al refresco posterior de la lista.

El control de foto por fila usa otra operación: envía el archivo junto con los identificadores de la fila del borrador, recibe un nombre y actualiza la referencia de imagen. Una foto recibida, una foto asociada y una miniatura que se puede mostrar no son la misma comprobación.

## Contradicciones y bloqueos reproducidos

| Hallazgo | Evidencia y consecuencia |
| --- | --- |
| **El ZIP puede adjuntarse antes de que exista su URL de envío.** | La extensión espera el input; la URL firmada llega por otra petición. Ejecutando la clase oficial con URL inicial nula, Rappi marca error sin realizar ningún PUT. Al llegar después la URL comienza el envío. La existencia del selector no demuestra que la preparación del servidor haya terminado. |
| **Una suscripción antigua puede conservar el ZIP previo.** | El handler oficial se suscribe a las actualizaciones de URL sin cerrar esa suscripción al destruir el drawer. En una reproducción con los métodos reales, una instancia destruida volvió a enviar su ZIP anterior cuando se publicó la URL del siguiente archivo. No se afirma que ocurriera en la cuenta del usuario. |
| **El archivo en el input se interpreta como un paso superado sin confirmar recepción.** | `esperarArchivosAsignados` comprueba el `File` local. El handler ZIP no vacía ese input; por tanto, el problema no es la desaparición de `files`. Lo que falta es distinguir esa asignación de un PUT aceptado y del procesamiento posterior. |
| **El detector no reconoce varios errores reales.** | La espera de la extensión busca textos globales de éxito, 404 o una frase sobre peso. Con los textos reales «¡Carpeta no pudo ser cargada!» y «Error en la carga del archivo», la reproducción termina por timeout en vez de informar el fallo. Tampoco reconoce automáticamente el texto libre que devuelve el servidor. Puede esperar diez minutos aunque el portal ya muestre un error. |
| **Si encuentra éxito y error, prioriza éxito.** | Ejecutando el detector con ambas frases devuelve `exito`. La búsqueda no está ligada a la etapa ni al drawer actual. Es una contradicción de decisión reproducida, no prueba de que ambos textos estuvieran activos en la sesión privada. |
| **Un error del procesamiento puede habilitar Continuar en Rappi.** | El frontend oficial llama a `onProcessingComplete()` tanto con `stage:completed` como con `stage:error`, y marca `success=true` y `canContinue=true`. El texto de error puede seguir visible en su plantilla. Por eso el botón habilitado por sí solo no confirma que las fotos se asociaron. |
| **El refresco de productos puede usar el modo incorrecto.** | El método oficial puede salir al encontrar el número de página antes de identificar la ruta personalizada. Se reprodujo una consulta con `isManual:false` desde `manual/:page`. Esto afecta al refresco de la lista; no debe confundirse con un parámetro ausente en la consulta de progreso de imágenes. |
| **«Producto listo» no verifica el archivo de imagen.** | La validación comprueba que exista una URL. El camino rápido del normalizador acepta archivos pequeños según cabecera o MIME sin decodificarlos. Se reprodujo un cuerpo HTML declarado `image/jpeg` incluido como JPEG en el ZIP. Las fotos reales de agenda examinadas sí eran PNG válidos; no se atribuye su fallo a este caso. |
| **No se comprueban las dimensiones.** | El archivo real de `40105`, 500 × 500, se acepta y conserva. La ayuda consultada indicaba un mínimo de 600 × 600; el diálogo compartido no muestra ese mínimo. Falta contrastar la regla efectiva del procesamiento antes de atribuirle un rechazo. |
| **La secundaria «opcional» no se trata siempre como opcional.** | Un HTTP 404 de la segunda foto se omite; un HTTP 200 con formato corrupto en esa misma posición aborta todo el lote, incluida la principal válida. Ambos casos se reprodujeron con el código productivo. |
| **La descarga de la fuente puede quedarse pendiente.** | Los GET de fotos y su lectura no tienen plazo propio ni AbortController. Si la red queda pendiente, la interfaz sigue ocupada antes de alcanzar las esperas de Rappi. Es distinto de esperar la descarga local de Chrome, que sí tiene control de terminación. |
| **La confirmación de una vista previa detiene las siguientes.** | El recorrido por fila espera que se pueda mostrar la primera imagen antes de adjuntar la siguiente. Los tres GET se reintentan aproximadamente en los segundos 1, 3 y 7; después se observa el mismo elemento hasta el timeout. Un fallo del CDN puede detener el lote aun cuando el archivo ya se recibió. |

Estas condiciones son generales del proceso de imágenes. Las reproducciones demuestran decisiones del código y del frontend público; no demuestran cuál de ellas ocurrió en cada trabajo privado de Rappi.

## Imágenes de productos que ya están creados

El flujo actual de la extensión recibe un único mensaje `RAPPI_SUBIR_LOTE`: plantilla, fotos del borrador y continuación de creación. No tiene una operación independiente para actualizar las imágenes de un producto definitivo.

El editor público de Rappi sí diferencia dos pasos: primero sube el archivo mediante `/cms/image/upload`; después, al guardar, incluye las referencias `images` en la actualización del producto de catálogo. Usa los identificadores del producto y de la referencia del vendedor, no el `file_id` del borrador de creación. Subir el binario por sí solo no completa ese guardado.

Esto permite separar conceptualmente la investigación de fotos de la creación que el usuario confirma que funciona. Para implementar una operación posterior habría que identificar el producto exacto y conservar sus demás datos al guardar las imágenes. No se implementó ese cambio ni se invocaron esas operaciones durante esta revisión.

## Qué no debe retirarse para forzar la subida

- Las comprobaciones de SKU y nombres duplicados evitan sobrescribir o asignar una foto a otro producto.
- La barrera de descargas completas antes de enviar a Rappi fue solicitada expresamente y funciona en otra etapa.
- Los límites de 48 MiB del mensaje de Chrome y 500 MB del ZIP de Rappi pertenecen a transportes distintos. Los archivos examinados están muy por debajo de ambos.
- La conversión base64/DataTransfer de las fotos examinadas conservó sus bytes. La imagen reportada anteriormente se recuperó íntegra del CDN. No hay evidencia de corrupción de esas fotos por ese transporte.

## Investigación siguiente centrada solo en imágenes

Registrar por archivo y producto las etapas de preparación, envío, procesamiento, asociación y lectura; conservar los errores originales y distinguirlos de los errores de vista previa. Observar Mi Tienda sin la capa opaca permite ver qué aviso muestra realmente el portal. La creación existente debe seguir siendo una operación separada y conservada mientras se valida el método adecuado para adjuntar y guardar fotos.

## Fuentes y alcance

- [Código de la extensión investigado](https://github.com/comunicadorpanafargo/Panafargo-Sync/tree/3ec6505b8fff0efc2478b5e0f3833a1cd8f5d96d).
- [Bundle oficial de catálogo de Rappi](https://mfe-partner-catalog.rappi.com.co/509.575c148061339d05.js): drawer ZIP, progreso, editor de producto y servicios de imágenes.
- [Entrada pública del catálogo](https://mfe-partner-catalog.rappi.com.co/mfePartnerCatalog.js), consultada en las revisiones de este día, conserva el hash del bundle citado.
- [Ayuda oficial de creación personalizada](https://rappi-backoffice-web.rappi.com/help/partnercenter/categories/creacion-de-productos/articles/como-crear-masivamente-productos-sin-codigo-de-barras-ean-opcion-personalizados).

Se usaron funciones reales extraídas, respuestas y DOM controlados e imágenes públicas. No se leyeron credenciales ni se enviaron imágenes o actualizaciones reales a Rappi. Las anomalías de su frontend no se presentan como una causa confirmada de todos los fallos de la cuenta.
