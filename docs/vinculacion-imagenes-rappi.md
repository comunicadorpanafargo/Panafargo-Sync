# Vínculo de nombres y control de carga masiva

Revisión del 29 de octubre de 2026. Versión 4.1.8. Se revisaron los nombres de producto, los SKU del Excel, los archivos dentro del ZIP y el control usado para adjuntarlo. No se modifican la creación ni la recuperación 404.

## Cómo se relaciona cada foto con el producto

El importador masivo recibe un ZIP de imágenes. La relación que documenta Rappi es el **SKU exacto en el nombre del archivo**. El nombre comercial o el nombre original de Shopify no se usan para esa coincidencia.

| SKU de la columna D del Excel | Principal | Secundaria 1 | Secundaria 2 |
| --- | --- | --- | --- |
| `4354323-1` | `4354323-1.jpg` | `4354323-1_1.jpg` | `4354323-1_2.jpg` |
| `4354323-2` | `4354323-2.jpg` | `4354323-2_1.jpg` | `4354323-2_2.jpg` |
| `40105` | `40105.jpg` | `40105_1.jpg`, si existe | `40105_2.jpg`, si existe |

El guion de `4354323-1` es parte de su referencia. El sufijo de las secundarias es **guion bajo**: `_1`, `_2`, etc. No se añade `-1` a una principal cuyo SKU sea `40105`, porque eso la identificaría con otra referencia. La extensión depende del formato real de cada foto: puede ser `.jpg`, `.png` o `.webp`.

El flujo conserva la misma identidad: `desdeShopify` → `producto.sku` → `rappiProduct.sku` → columna D. El generador de imágenes usa ese `producto.sku` para los nombres. El prefijo `PANAFARGOSAS_` pertenece a la plantilla posterior de asociación; no se agrega a las fotos del borrador.

Se reprodujeron los ejemplos con los módulos y las bibliotecas reales de Excel y ZIP. Las celdas de SKU son texto, incluidos ceros iniciales y guiones. Los archivos descargado y enviado conservan los mismos bytes.

## La captura de `40105`

La captura muestra `40105`, tipo «Archivo JPG», tamaño 19 KB. Es consistente con Windows ocultando la extensión `.jpg`. No demuestra por sí sola que se haya perdido el vínculo con el SKU.

La fuente pública de `40105`, archivada durante la revisión del 29 de octubre, tiene una sola foto. Su preparación genera `40105.jpg`, de 18.886 bytes, consistente con el tamaño mostrado. No se abrió el ZIP de la computadora del usuario; esta comprobación se hizo con la fuente pública archivada. Para contrastar un lote concreto se deben comparar su columna D y los nombres contenidos en su propio ZIP.

## Qué control de Rappi se utiliza

El frontend público confirma este recorrido:

1. El enlace **Cárgalas aquí**, en la revisión, abre el panel de instrucciones de imágenes masivas.
2. El componente `app-handle-images-actions` contiene un `lib-drawer` con el botón **Subir archivo** y su `input.file[type=file][accept=.zip]`, oculto por diseño.
3. El botón llama a `inputFile.nativeElement.click()` para abrir el selector del sistema operativo.
4. La selección dispara `change`; el componente llama a `handleLoadFile(event.target.files)` y envía el ZIP a la URL firmada que recibió de Rappi.

La extensión abre el enlace y asigna el ZIP al **mismo input nativo**, mediante `DataTransfer` y un único `change`. Así utiliza el manejador masivo del portal sin abrir un selector de archivos que requiera intervención del usuario. No envía las fotos mediante controles individuales por producto.

## Corrección de 4.1.8

En 4.1.7, después de abrir el panel correcto, `esperarSelector(SELECTOR_INPUT_ZIP)` buscaba en todo el documento. En una reproducción con otro selector ZIP anterior al del panel, el archivo se adjuntaba a ese otro formulario. Comprobar que `input.files` tiene un ZIP no revelaba la equivocación.

Ahora la búsqueda se limita al panel masivo abierto y a su control de archivos. Los inputs ocultos por diseño siguen siendo válidos cuando su panel está abierto. Los formularios ajenos y paneles ocultos no son candidatos. Si hay varios destinos activos o el control no puede confirmarse, no se adjunta el ZIP ni se continúa con la creación.

La identificación de la etapa usa el mismo criterio. Un selector ZIP de otro formulario no hace que una pantalla de plantilla se interprete como revisión de imágenes. Una vista ambigua exige revisión, sin seleccionar ni modificar ningún archivo.

La reproducción demuestra una selección incorrecta posible en el código anterior. No demuestra que otro selector estuviera presente en la sesión privada del usuario ni establece una causa única de los fallos del servicio de Rappi.

## Fuentes y alcance

- Módulos de modelo, conector, generación Excel/ZIP e interfaz del repositorio.
- [Bundle público de Rappi](https://mfe-partner-catalog.rappi.com.co/509.575c148061339d05.js): enlace de imágenes masivas, componente `app-handle-images-actions`, botón e input ZIP, método `handleLoadFile`.
- Traducciones oficiales de catálogo y capturas de las instrucciones proporcionadas por el usuario: nombres por SKU y secundarias con `_n`.

La validación usa archivos reales generados por los módulos, controles nativos reproducidos en un navegador local y respuestas simuladas. No se subieron fotografías ni se crearon productos en la cuenta privada durante esta comprobación.
