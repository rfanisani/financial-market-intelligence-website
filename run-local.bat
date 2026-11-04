@echo off
rem ============================================================================
rem  Market Radar (financial-market-intelligence-website) - local launcher
rem
rem  Usage:
rem    run-local.bat           Build public/ from data/, run tests, then serve
rem                            (the site opens in your browser automatically)
rem    run-local.bat fetch     Update market data from providers (needs internet),
rem                            then build, test and serve
rem    run-local.bat test      Run the test suite and size check only
rem    run-local.bat help      Show this help
rem
rem  Environment (optional):
rem    PORT=8090               First port to try (falls forward if busy)
rem    NO_OPEN=1               Do not open the browser automatically
rem ============================================================================
setlocal
cd /d "%~dp0"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=run"
if /i "%CMD%"=="help" goto usage
if /i "%CMD%"=="fetch" goto fetch
if /i "%CMD%"=="test" goto testonly
if /i "%CMD%"=="run" goto run
echo Unknown command: %CMD%
goto usage_fail

:usage
echo Market Radar local launcher
echo.
echo   run-local.bat           Build, test, then serve (browser opens)
echo   run-local.bat fetch     Update market data first (needs internet)
echo   run-local.bat test      Run tests and size check only
echo   run-local.bat help      Show this help
echo.
echo Optional: set PORT=8090 to choose the first port; set NO_OPEN=1 to skip opening the browser.
endlocal
exit /b 0

:usage_fail
echo.
echo Run "run-local.bat help" to see the options.
pause
endlocal
exit /b 1

:fetch
call :need_node
if errorlevel 1 goto fail
echo [1/5] Fetching market data from the providers...
node scripts/fetch-data.mjs
if errorlevel 1 goto fail
goto build_step

:run
call :need_node
if errorlevel 1 goto fail
goto build_step

:build_step
echo [2/5] Building public/...
node scripts/build.mjs
if errorlevel 1 goto fail
echo [3/5] Running tests...
node scripts/test.mjs
if errorlevel 1 goto fail
echo [4/5] Checking bundle size...
node scripts/size-check.mjs
if errorlevel 1 goto fail
goto serve

:testonly
call :need_node
if errorlevel 1 goto fail
node scripts/test.mjs
if errorlevel 1 goto fail
node scripts/size-check.mjs
if errorlevel 1 goto fail
echo.
echo All checks passed.
pause
endlocal
exit /b 0

:serve
echo [5/5] Starting the local server...
node scripts/serve-local.mjs
goto end

:need_node
where node >nul 2>nul
if errorlevel 1 goto no_node
exit /b 0

:no_node
echo Node.js was not found. Install the LTS version from https://nodejs.org and open a new window.
exit /b 1

:fail
echo.
echo Something failed. See the messages above.
pause
endlocal
exit /b 1

:end
echo.
echo The server has stopped.
pause
endlocal
exit /b 0
