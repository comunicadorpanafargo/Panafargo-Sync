# Carga masiva de imágenes: comparación y alcance de 4.1.7

Revisión del 29 de octubre de 2026. El usuario confirma que la creación funciona y pide conservarla, recuperar el comportamiento masivo anterior, exigir las secundarias y dejar pendiente `/`.

## Comparación con las versiones antiguas

| Versión examinada | Preparación y recorrido de imágenes |
| --- | --- |
| `fc480a0` | Solo `.gitignore`; no contiene una implementación que se pueda recuperar. |
| `373627f`, primer sistema 4.0.0, 23 de octubre | Principal `SKU.ext`, hasta una secundaria `SKU_1.ext`; Excel → revisión → **Cárgalas aquí** → ZIP → procesamiento → creación. Un HTTP fallido o una secundaria vacía se omitían. |
| `9944342`, 4.0.0 | Conserva el mismo recorrido masivo. |
| `90a8b93`, 4.1.0 | Conserva el ZIP y agrega identidad de publicaciones por SKU completo. |
| `0add13a`, 4.1.2, hasta 4.1.6 | Si cualquier seleccionado tiene `/`, todo el lote pasa a controles individuales. Ese camino prepara solo la principal; el ZIP descargado es un respaldo con mapas, no un importable. Los SKU normales siguen usando la carga masiva original. |
| 4.1.7 | La interfaz usa exclusivamente el ZIP masivo para SKU compatibles, con todas las fotos obtenidas y sin omisiones. Los SKU con separadores quedan pendientes y pueden desmarcarse para continuar con los demás. |

Las funciones originales de asignación al input y espera del ZIP se compararon con 4.1.6. La asignación del archivo, su conversión base64 y la espera de `files` eran iguales. El detector de resultado también conservaba sus carencias desde 4.0.0: texto global, prioridad del éxito y errores no reconocidos. Recuperar literalmente todo el archivo antiguo habría recuperado esos fallos.

## Funcionamiento actual

1. **Buscar y validar** obtiene la imagen de la variante, la principal del producto y toda su galería de Shopify. La imagen propia de variante conserva prioridad. Las URL repetidas se eliminan conservando el orden.
2. La primera consulta pide dos fotos por producto para contener el coste de buscar 50 variantes. Si hay más, se consultan páginas adicionales de hasta 250 imágenes, una vez por producto y búsqueda. Un error o un cursor inválido rechaza el resultado parcial.
3. `imagenes_completas` acredita que se alcanzó la última página. Los productos guardados por versiones antiguas no tienen esa marca y deben volver a buscarse antes de crear: pueden contener una galería truncada aunque sus dos primeras fotos sean válidas.
4. **Crear productos** descarga cada URL incluida y genera `SKU.ext`, `SKU_1.ext`, `SKU_2.ext`, etc. Toda secundaria existente es obligatoria. Si Shopify solo tiene una foto, no se inventa otra. HTTP fallido, contenido vacío, lectura interrumpida o contenido no reconocible detienen la preparación e identifican la foto. No se devuelve un ZIP incompleto.
5. Los formatos admitidos son JPG/PNG/WEBP y cada imagen queda bajo el límite de 1.000.000 bytes. Otros formatos reconocibles o imágenes demasiado grandes se recodifican con el mecanismo existente. No se amplían las dimensiones artificialmente. Se comprueban firmas del contenido; una respuesta HTML con MIME `image/jpeg` se rechaza. La firma no demuestra por sí sola una decodificación completa.
6. Los nombres de todas las fotos se comparan contra los del resto del lote: por ejemplo, una secundaria `A_2.jpg` no puede sobrescribir la principal de un producto cuyo SKU sea `A_2`.
7. Se generan una sola vez el Excel y el ZIP. Chrome debe confirmar ambas descargas completas antes del envío. El ZIP descargado y el enviado tienen exactamente los mismos bytes. No incluye mapas, instrucciones ni nombres hash.
8. La extensión abre **Cárgalas aquí**, adjunta ese ZIP al selector nativo y observa su procesamiento dentro del componente `app-handle-images-actions` correspondiente al input actual. Mi Tienda queda visible, sin pantalla superpuesta.
9. El detector reconoce errores visibles de procesamiento, incluidos textos libres del servidor, y errores de transferencia antes que cualquier frase de éxito. El 100 %, la clase `success` o el botón Continuar habilitado no bastan. Se requieren las señales terminales de procesamiento del panel.
10. Un error inicial de Rappi mientras llega la URL firmada se mantiene bajo observación hasta una señal terminal o el timeout general existente. No se libera el bloqueo por un plazo corto, se repite `change` ni se reenvía el ZIP automáticamente: la URL puede llegar tarde e iniciar el envío nativo. Los errores terminales de procesamiento y transferencia se informan inmediatamente. Si se agota la espera sin un resultado confirmado, se pide revisar Mi Tienda antes de repetir el lote.
11. Después se llama a la función de creación existente. **Su cuerpo y las protecciones contra repetir Crear son iguales a 4.1.6.** Tampoco se cambian precios, reserva, plantillas, asociación ni recuperación de la pantalla 404.

Antes de comenzar y después de las descargas se comprueba que Mi Tienda tenga cargada la misma versión de la extensión. Tras actualizar: conservar `shopify/config.js`, recargar la extensión, pulsar F5 en Mi Tienda y volver a **Buscar y validar**.

## Qué queda pendiente

- El ZIP sigue sin una vinculación confirmada para nombres que contengan `/`. No se sustituyen los códigos por alias ni se cambia su inventario. El botón Crear se deshabilita mientras haya esos SKU seleccionados; pueden desmarcarse. Su consulta y asociación por SKU completo se conservan.
- El código experimental individual queda conservado para investigación, fuera de la ruta usada por la interfaz. No se anuncia como solución activa.
- Las anomalías del frontend privado de Rappi —URL firmada tardía, suscripciones antiguas o refresco de lista— no se reparan desde la extensión en esta entrega. Se muestran sus errores; no se promete que todo fallo provenga de una sola causa.
- La recuperación 404 heredada continúa igual por la instrucción de no tocar creación. La presencia de Asociar por sí sola no acredita una cantidad positiva creada; ese resultado debe revisarse en Mi Tienda.
- Los GET de fotografías aún no tienen un plazo propio; el presupuesto de mensajes Chrome exige dividir los lotes grandes. La comprobación de dimensiones efectivamente exigidas por Rappi sigue pendiente; no se fuerza un mínimo inventado.

## Recomendaciones

1. **Comprobar un lote pequeño real con varias fotografías.** Confirmar que Rappi muestra principal y secundarias, no solo que recibió el ZIP. Después aumentar el tamaño del lote. Las pruebas locales no acreditan una ejecución en la cuenta privada.
2. **Mostrar un resumen de fotos antes de enviar.** Principal, cantidad de secundarias y total de archivos por producto; permite detectar una galería incorrecta antes de crear.
3. **Guardar estados por trabajo y producto.** Distinguir Excel recibido, ZIP transferido, imágenes procesadas y productos creados. Conservar el error original y los identificadores del trabajo, sin guardar URL firmadas ni tokens.
4. **Reintentar solo imágenes.** Una operación posterior debe vincular fotos al producto definitivo sin repetir su creación ni sobrescribir sus precios o existencias. El editor oficial sube el archivo y después guarda sus referencias; el contrato de guardado requiere validarse antes de implementarlo.
5. **Añadir plazos de descarga y cancelación.** Un GET de Shopify pendiente no debería ocupar la interfaz indefinidamente. La cancelación debe distinguir preparación local de operaciones ya enviadas.
6. **Preparar Mercado Libre sobre el núcleo compartido.** Consulta y selección comunes; validaciones, fotos, precios y estados separados por destino. Antes de publicar, reconciliar las publicaciones existentes. Para credenciales y trabajos duraderos, prever un servicio con OAuth y almacenamiento seguro.

## Fuentes y validación

- Historial local y remoto del [repositorio](https://github.com/comunicadorpanafargo/Panafargo-Sync), incluyendo las revisiones de la tabla.
- [Bundle público de Rappi](https://mfe-partner-catalog.rappi.com.co/509.575c148061339d05.js): componente `app-handle-images-actions`, estados de transferencia y procesamiento, clases `upload-manager`, progreso, errores y acción Continuar.
- [Traducciones oficiales](https://mitienda.rappi.com.co/assets/i18n/es-CO.json) y traducciones de catálogo: textos de éxito y error. La etapa `error` puede habilitar Continuar sin que hayan quedado asociadas las imágenes.
- [Product de Shopify](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product) e [ImageConnection](https://shopify.dev/docs/api/admin-graphql/latest/connections/ImageConnection), consultados el 29 de octubre: `images`, `first`, `after` y `pageInfo`. No se cambió la versión privada configurada de API.

Las pruebas comprueban paginación completa, orden y bytes del ZIP, secundarias fallidas, colisiones, descargas completas, caché antigua, versión de la pestaña y estados nativos de imágenes con DOM controlado. Se compara además la creación con 4.1.6. No se usaron credenciales ni se crearon productos o subieron fotos reales durante el desarrollo.
