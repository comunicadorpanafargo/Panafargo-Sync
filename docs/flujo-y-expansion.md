# Flujo, limpieza y expansión

## Cambios de interfaz

Las capturas originales mostraban tablas de cinco y seis columnas dentro de una ventana estrecha, códigos partidos, acciones deshabilitadas sin suficiente contexto y un botón «Extraer SKU» que acababa descargando una matriz. Los pasos de creación y asociación tampoco quedaban suficientemente diferenciados.

Se implementaron tres pasos con nombres de tarea: revisar, preparar y asociar. Las tarjetas conservan legibles los SKU completos, explican los bloqueos y separan el inventario de origen de la cantidad disponible para Rappi. El resumen usa unidades de conteo explícitas. La ventana es más amplia y la presentación se adapta también a tamaños pequeños.

Se eliminaron clics y descargas obligatorios: no hay validación individual separada, los resultados se preparan automáticamente, las publicaciones listas aparecen seleccionadas, la plantilla de asociación se guarda al elegirla y las imágenes se descargan en un solo paquete. Se conservan el lote y las selecciones al recargar. Existe un reinicio explícito y reintento solo de pendientes.

Las capturas aportadas se revisaron. El MP4 y el ZIP de la grabación superaron el límite de transferencia de32MiB y no pudieron inspeccionarse; no se atribuyen observaciones adicionales al video.

## Código depurado

- Pantalla individual sin acceso desde la navegación y sus listeners.
- Controles de categorías inalcanzables, descarga individual del flujo de lote y subida oculta de la plantilla de asociación sin transformar.
- Funciones de almacenamiento, marcas, historial y esperas sin consumidores; declaración duplicada de un helper del portal.
- Arrays de marcas y unidades que no usaba ningún módulo: se retiraron aproximadamente200KB sin cambiar las987 categorías ni4 equivalencias de peso activas.
- Permiso `windows` innecesario y exposición web de una plantilla que solo necesita leer la propia extensión.

Se mantiene un único cálculo de precio, la reserva existente y las plantillas del repositorio. La búsqueda agrupa consultas por base y el almacenamiento guarda el lote completo de forma atómica. Ni la clave del almacenamiento ni las existencias se agrupan por base.

## Límites que deben verificarse en Rappi

El SKU con `/` se conserva en Excel y en la asociación, pero el formato de vinculación de imágenes de Rappi no está confirmado para estos identificadores. Codificar el nombre local no demuestra compatibilidad del importador. El lote se detiene en revisión antes de crear productos y ofrece las imágenes y su mapa para asignarlas manualmente.

No se reanuda una revisión antigua con imágenes de un lote nuevo. Se rechazan cargas simultáneas o durante el reintento activo de Rappi. Se conserva la confirmación final de asociación en el portal.

## Próximas mejoras por prioridad

1. **Verificar imágenes por diseño en el portal real.** Con un lote pequeño y una grabación accesible o DOM confirmado, documentar cómo Rappi identifica cada archivo y automatizar esa asignación sin modificar el SKU. Este es el bloqueo concreto para completar el camino automático de `/`.
2. **Historial de trabajos y prevención de reenvíos.** Identificador de lote, estado por publicación y comprobación del resultado antes de permitir repetir una creación. Requiere una señal fiable del portal; una descarga o un botón pulsado no prueba publicación.
3. **Reintentos por fallos recuperables.** Reintentar imágenes o consultas fallidas con límites, evitando repetir creaciones ya confirmadas. Mostrar fase y pendientes, con cancelación segura antes de enviar.
4. **Importación de inventario con reglas explícitas.** Si se incorpora Webcol, solo actualizar referencias base autorizadas. Una fila base nunca debe sobrescribir el conteo manual de un SKU con `/`; cualquier actualización de Shopify debe ser una operación separada y revisable.

## Incorporar Mercado Libre sin duplicar el sistema

La identidad compartida debe mantener SKU completo, base, variante y producto de origen, imágenes propias, precio normal e inventario de origen. La preparación de un lote recibe la búsqueda, normalización y validación como funciones; no necesita conocer credenciales ni el formato del marketplace.

Cada destino debe implementar su propia validación, precio, stock disponible, categoría, atributos, exportación o API y resultado verificable. La reserva de Rappi, su prefijo de asociación y su Excel no deben convertirse en reglas de Mercado Libre. Tampoco debe bloquearse un producto para todos los destinos solo porque le falte un campo exclusivo de Rappi.

Para Mercado Libre faltan una conexión OAuth autorizada, renovación segura de credenciales, elección de sitio, categorías y atributos obligatorios, política de variantes/publicaciones, SKU del vendedor, precio, existencias y reglas para crear o actualizar sin duplicados. La implementación debe comenzar con validación y vista previa; después, publicación explícita y trazabilidad de los identificadores remotos.

No se añadieron botones ficticios de Mercado Libre ni se inventaron endpoints o permisos. El adaptador se puede incorporar manteniendo el flujo compartido y las pruebas de identidad e inventario.
