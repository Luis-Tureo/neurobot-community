# Implementación controlada de bienvenida programada

Este cambio incorpora temporalmente un generador validado por GitHub Actions. Al entrar a `main`, el workflow aplica la implementación completa, ejecuta `npm run check` y solo si toda la validación termina correctamente crea el commit funcional. El mismo generador elimina sus archivos temporales antes de ese commit.