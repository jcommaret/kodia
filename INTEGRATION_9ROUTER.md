# Integración de 9Router con Kodia

Este documento explica cómo usar **9Router** con **Kodia** para obtener acceso ilimitado y gratuito a múltiples modelos de IA.

## ¿Qué es 9Router?

9Router es un router inteligente para APIs de IA que:
- ✅ **Ahorra 20-40% de tokens** con RTK Token Saver
- ✅ **Auto-fallback** entre proveedores (Subscription → Cheap → Free)
- ✅ **Multi-cuenta** con round-robin automático
- ✅ **40+ proveedores** incluidos (Anthropic, OpenAI, Gemini, Ollama, etc.)
- ✅ **Modelos gratuitos** como Kiro AI, OpenCode Free, Vertex AI

## Instalación de 9Router

### Opción 1: NPM Global (Recomendada)
```bash
npm install -g 9router
9router
```

El dashboard se abrirá en `http://localhost:20128`

### Opción 2: Desde el código fuente
```bash
git clone https://github.com/decolua/9router.git
cd 9router
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

## Configuración en Kodia

Una vez que 9Router esté corriendo, sigue estos pasos:

### 1. Abre Kodia Settings
- Presiona `Cmd+,` (Mac) o `Ctrl+,` (Windows/Linux)
- O busca "Settings" en la paleta de comandos

### 2. Navega a la sección de Providers
- Busca el proveedor **"9Router"**

### 3. Configura 9Router
- **Endpoint**: `http://localhost:20128` (ya está pre-configurado)
- **API Key**: Copia el API key desde el dashboard de 9Router en `http://localhost:20128/dashboard`
  - Si no tienes un API key, 9Router puede funcionar sin él para algunos proveedores gratuitos

### 4. Selecciona un modelo
Los modelos disponibles a través de 9Router incluyen:

**Gratuitos (a través de Kiro AI - ~50 créditos/mes):**
- `kr/claude-sonnet-4.5`
- `kr/glm-5`
- `kr/minimax`

**Gratuitos (a través de OpenCode Free):**
- `opencode/claude-sonnet-4.5`
- `opencode/gpt-4`

**Con créditos gratuitos (Vertex AI - $300 para nuevas cuentas):**
- `google/gemini-3.8-flash`

**Con API Keys propias (si las tienes):**
- `anthropic/claude-sonnet-4.5`
- `openai/gpt-5`

### 5. Configura el modelo para cada característica
- **Chat**: Selecciona el modelo que prefieras
- **Apply**: Selecciona el modelo para aplicar cambios
- **Ctrl+K**: Selecciona el modelo para edición rápida
- **Autocomplete**: Selecciona un modelo con soporte FIM

## Configurar proveedores gratuitos en 9Router

### Kiro AI (Recomendado)
1. Abre `http://localhost:20128/dashboard`
2. Ve a **Providers** → **Connect Kiro AI**
3. Obtendrás ~50 créditos/mes gratis (Claude 4.5 + GLM-5 + MiniMax)
4. 500 créditos extra para nuevas cuentas en los primeros 30 días

### OpenCode Free
1. En el dashboard de 9Router
2. Ve a **Providers** → **Connect OpenCode Free**
3. No requiere autenticación

### Vertex AI
1. Crea una cuenta en [Google Cloud Platform](https://cloud.google.com)
2. Nuevas cuentas obtienen $300 en créditos
3. Configura en 9Router: **Providers** → **Google Vertex AI**

## Configuración avanzada

### Auto-fallback en capas
9Router cambiará automáticamente entre proveedores según disponibilidad:

```
Tier 1: Tu suscripción principal (si tienes)
   ↓ cuota agotada
Tier 2: Proveedores económicos (GLM $0.6/1M, MiniMax $0.2/1M)
   ↓ límite alcanzado
Tier 3: Proveedores gratuitos (Kiro, OpenCode, Vertex)
```

### RTK Token Saver
9Router comprime automáticamente los `tool_result` para ahorrar tokens. No requiere configuración adicional.

### Multi-cuenta
Puedes agregar múltiples cuentas del mismo proveedor en 9Router y hará round-robin automáticamente.

## Verificación

Para verificar que la integración funciona:

1. Abre el chat de Kodia
2. Escribe un mensaje de prueba
3. Deberías ver la respuesta del modelo configurado
4. En el dashboard de 9Router (`http://localhost:20128/dashboard`) verás las estadísticas de uso

## Troubleshooting

### "Connection refused" o "ECONNREFUSED"
- Verifica que 9Router esté corriendo: `http://localhost:20128`
- El puerto por defecto es 20128, si lo cambiaste, actualiza el endpoint en Kodia

### "Invalid API Key"
- Algunos proveedores gratuitos no requieren API key
- Para Kiro y otros, copia el API key desde el dashboard de 9Router
- Si usas proveedores sin autenticación (OpenCode Free), deja el campo vacío o usa "noop"

### No aparecen modelos
- Verifica que 9Router tenga al menos un proveedor conectado
- Ve a `http://localhost:20128/dashboard` y conecta un proveedor gratuito
- Reinicia Kodia después de configurar proveedores en 9Router

### Errores de rate limit
- 9Router debería manejar esto automáticamente con auto-fallback
- Si persiste, agrega más proveedores gratuitos en 9Router

## Recursos adicionales

- **9Router GitHub**: https://github.com/decolua/9router
- **9Router Dashboard**: http://localhost:20128/dashboard
- **Documentación de Kodia**: https://github.com/jcommaret/kodia
- **Modelos disponibles**: Verifica la lista actualizada en el dashboard de 9Router

## Notas importantes

1. **Privacidad**: 9Router corre localmente en tu máquina, no envía datos a servidores externos
2. **Límites gratuitos**: Los proveedores gratuitos tienen límites mensuales (ej: Kiro ~50 créditos/mes)
3. **Actualización de modelos**: 9Router actualiza automáticamente la lista de modelos disponibles
4. **Compatibilidad**: 9Router es compatible con todas las características de Kodia (Chat, Apply, Ctrl+K, Autocomplete)

---

**¿Necesitas ayuda?** Abre un issue en:
- Kodia: https://github.com/jcommaret/kodia/issues
- 9Router: https://github.com/decolua/9router/issues
