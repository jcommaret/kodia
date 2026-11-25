# Script de verificacion de la integracion de 9Router
# Este script verifica que todos los cambios se aplicaron correctamente

Write-Host "Verificando integracion de 9Router con Kodia..." -ForegroundColor Cyan
Write-Host ""

$errores = 0
$advertencias = 0

# Verificar que los archivos existen
Write-Host "Verificando archivos modificados..." -ForegroundColor Yellow

$archivos = @(
    "src/vs/workbench/contrib/void/common/modelCapabilities.ts",
    "src/vs/workbench/contrib/void/common/voidSettingsTypes.ts",
    "src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts"
)

foreach ($archivo in $archivos) {
    if (Test-Path $archivo) {
        Write-Host "  OK $archivo" -ForegroundColor Green
    } else {
        Write-Host "  ERROR $archivo NO ENCONTRADO" -ForegroundColor Red
        $errores++
    }
}

Write-Host ""

# Verificar contenido de modelCapabilities.ts
Write-Host "Verificando modelCapabilities.ts..." -ForegroundColor Yellow
$contenido1 = Get-Content "src/vs/workbench/contrib/void/common/modelCapabilities.ts" -Raw

if ($contenido1 -match "nineRouter:") {
    Write-Host "  OK Configuracion de nineRouter encontrada" -ForegroundColor Green
} else {
    Write-Host "  ERROR Configuracion de nineRouter NO encontrada" -ForegroundColor Red
    $errores++
}

if ($contenido1 -match "http://localhost:20128") {
    Write-Host "  OK Endpoint configurado correctamente" -ForegroundColor Green
} else {
    Write-Host "  ERROR Endpoint NO configurado" -ForegroundColor Red
    $errores++
}

if ($contenido1 -match "kr/claude-sonnet-4.5") {
    Write-Host "  OK Modelos de catalogo encontrados" -ForegroundColor Green
} else {
    Write-Host "  ERROR Modelos de catalogo NO encontrados" -ForegroundColor Red
    $errores++
}

Write-Host ""

# Verificar contenido de voidSettingsTypes.ts
Write-Host "Verificando voidSettingsTypes.ts..." -ForegroundColor Yellow
$contenido2 = Get-Content "src/vs/workbench/contrib/void/common/voidSettingsTypes.ts" -Raw

if ($contenido2 -match "9Router") {
    Write-Host "  OK Titulo de 9Router encontrado" -ForegroundColor Green
} else {
    Write-Host "  ERROR Titulo de 9Router NO encontrado" -ForegroundColor Red
    $errores++
}

if ($contenido2 -match "github.com/decolua/9router") {
    Write-Host "  OK Documentacion de 9Router encontrada" -ForegroundColor Green
} else {
    Write-Host "  ERROR Documentacion de 9Router NO encontrada" -ForegroundColor Red
    $errores++
}

Write-Host ""

# Verificar contenido de sendLLMMessage.impl.ts
Write-Host "Verificando sendLLMMessage.impl.ts..." -ForegroundColor Yellow
$contenido3 = Get-Content "src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts" -Raw

if ($contenido3 -match "providerName === 'nineRouter'") {
    Write-Host "  OK Implementacion de nineRouter encontrada" -ForegroundColor Green
} else {
    Write-Host "  ERROR Implementacion de nineRouter NO encontrada" -ForegroundColor Red
    $errores++
}

if ($contenido3 -match "sendLLMMessageToProviderImplementation" -and $contenido3 -match "nineRouter:") {
    Write-Host "  OK Registro en sendLLMMessageToProviderImplementation encontrado" -ForegroundColor Green
} else {
    Write-Host "  ERROR Registro en sendLLMMessageToProviderImplementation NO encontrado" -ForegroundColor Red
    $errores++
}

Write-Host ""

# Verificar archivos de documentacion
Write-Host "Verificando documentacion..." -ForegroundColor Yellow

if (Test-Path "INTEGRATION_9ROUTER.md") {
    Write-Host "  OK INTEGRATION_9ROUTER.md creado" -ForegroundColor Green
} else {
    Write-Host "  ADVERTENCIA INTEGRATION_9ROUTER.md NO encontrado" -ForegroundColor Yellow
    $advertencias++
}

if (Test-Path "CHANGELOG_9ROUTER.md") {
    Write-Host "  OK CHANGELOG_9ROUTER.md creado" -ForegroundColor Green
} else {
    Write-Host "  ADVERTENCIA CHANGELOG_9ROUTER.md NO encontrado" -ForegroundColor Yellow
    $advertencias++
}

Write-Host ""

# Verificar que 9Router esta corriendo (opcional)
Write-Host "Verificando si 9Router esta corriendo..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:20128" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($response.StatusCode -eq 200) {
        Write-Host "  OK 9Router esta corriendo en http://localhost:20128" -ForegroundColor Green
    }
} catch {
    Write-Host "  ADVERTENCIA 9Router NO esta corriendo (esto es opcional)" -ForegroundColor Yellow
    Write-Host "     Para iniciar: npm install -g 9router && 9router" -ForegroundColor Gray
    $advertencias++
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan

# Resultado final
if ($errores -eq 0) {
    Write-Host "VERIFICACION EXITOSA: Todos los cambios estan correctos" -ForegroundColor Green
    if ($advertencias -gt 0) {
        Write-Host "ADVERTENCIA: $advertencias advertencia(s) - revisar arriba" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Proximos pasos:" -ForegroundColor Cyan
    Write-Host "   1. Compilar React UI: npm run buildreact" -ForegroundColor White
    Write-Host "   2. Iniciar watch: npm run watch" -ForegroundColor White
    Write-Host "   3. Ejecutar Kodia: ./scripts/code.sh (o code.bat en Windows)" -ForegroundColor White
    Write-Host "   4. Configurar 9Router en Settings -> Providers -> 9Router" -ForegroundColor White
    Write-Host ""
    Write-Host "Documentacion completa en: INTEGRATION_9ROUTER.md" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "VERIFICACION FALLIDA: Se encontraron $errores error(es)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Por favor revisa los mensajes de error arriba." -ForegroundColor Yellow
    exit 1
}
