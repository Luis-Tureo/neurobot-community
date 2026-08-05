# Moderación local por reglas

## Alcance y seguridad

El módulo **Moderación y reglas** analiza únicamente mensajes nuevos de grupos mediante condiciones ejecutadas en el servidor local. No llama a Groq, no usa la cola de IA, no consume tokens y continúa funcionando aunque el proveedor de IA esté desactivado. Nunca expulsa participantes ni elimina mensajes automáticamente.

Está disponible para `COMMUNITY_GROUPS` y para el canal grupal de `BUSINESS_MIXED`. No aparece en `BUSINESS_PRIVATE`. La configuración, las reglas, los términos, los casos y las métricas quedan aislados mediante `assistantId`.

La migración crea el módulo desactivado. Para comenzar:

1. Administrar el asistente.
2. Abrir **Moderación y reglas**.
3. Crear una regla con al menos una condición concreta.
4. Probarla en **Pruebas**; el texto de simulación no se guarda.
5. Configurar los grupos.
6. Activar el interruptor principal.

Al desactivarlo se conservan reglas y estadísticas, pero los mensajes nuevos dejan de analizarse. Nunca se revisa historial ni se generan advertencias retroactivas.

## Reglas y condiciones

Cada regla define nombre, explicación, categoría, gravedad, puntuación, umbrales, condiciones y excepciones. El texto explicativo no se convierte automáticamente en lógica. Una regla activa requiere condiciones estructuradas.

Tipos disponibles:

- palabra completa y frase;
- combinación de palabras;
- término dentro del texto;
- repetición y frecuencia;
- dominio bloqueado;
- publicidad;
- posible información personal;
- mayúsculas excesivas en mensajes suficientemente largos;
- patrón avanzado validado y limitado.

Los patrones avanzados rechazan expresiones largas, referencias retrospectivas, construcciones complejas y cuantificadores anidados. No se ejecuta código ingresado por el administrador.

Las excepciones pueden permitir palabras, frases, dominios o mensajes administrativos. Se evalúan antes de puntuar. Las listas de términos son locales, editables y nunca se alimentan automáticamente con mensajes reales.

## Puntuación y acciones

Los valores recomendados son:

- 0 a 2 puntos: sin acción pública;
- 3 puntos: revisión administrativa;
- 4 puntos o más: advertencia;
- gravedad crítica: advertencia segura y caso prioritario.

Los umbrales se configuran por asistente y por regla. Una coincidencia en revisión puede continuar hacia la respuesta normal de Neurobot. Una coincidencia clara detiene la respuesta de IA para evitar contestar y consumir tokens sobre un mensaje que requiere moderación.

## Advertencias y reincidencia

La primera advertencia utiliza lenguaje neutral: indica que es automática, que el mensaje **podría** incumplir las reglas y que la administración puede revisarla. La segunda informa una reincidencia y crea aviso administrativo. Desde la tercera coincidencia se prioriza el caso y se limita la repetición pública.

Valores iniciales:

- reincidencia durante 7 días;
- una advertencia por persona cada 10 minutos;
- tres advertencias públicas por grupo cada 30 minutos;
- un mensaje duplicado se procesa una vez.

Al expirar el periodo se elimina el contador activo y los hashes de participante y mensaje de casos antiguos dejan de permitir vincular conductas futuras.

## Revisión humana y falsos positivos

Los casos permiten confirmar, marcar falso positivo, descartar o resolver. Un falso positivo reduce la reincidencia activa y mantiene solo la estadística anónima. No agrega automáticamente contenido a una lista permitida.

La expulsión no forma parte del motor automático ni de estas rutas. Una sanción futura deberá exigir permisos, contraseña, doble confirmación, razón y auditoría separada.

## Evidencia temporal y privacidad

Cuando el cifrado local está disponible, puede conservarse un fragmento temporal cifrado durante 72 horas. Antes de cifrar se ocultan teléfonos y correos, se limita la longitud y no se incorporan mensajes anteriores ni archivos. Al expirar se elimina el cifrado y se conserva solamente información técnica del caso.

No se registran mensajes, nombres, números, identificadores reales, evidencia descifrada, claves ni tokens. Participante, grupo y mensaje se representan mediante hashes con secreto. La exportación incluye solamente configuración, reglas y términos; excluye incidentes y datos personales.

## Importación, exportación y pruebas

La exportación produce una configuración estructurada sin incidentes. La importación valida el formato, omite nombres de reglas duplicados y deja todo importado como borrador para revisión. No ejecuta código ni activa reglas automáticamente.

El probador muestra coincidencias, categoría, puntuación, excepciones y acción hipotética. No guarda el texto, no crea casos, no suma reincidencias, no envía WhatsApp y no utiliza Groq.

Las métricas muestran mensajes revisados, permitidos, coincidencias, advertencias, casos, falsos positivos y errores locales. `aiReviews` y `aiTokens` permanecen en cero por restricción de base de datos.
