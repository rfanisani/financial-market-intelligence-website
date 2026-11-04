@echo off
setlocal
rem Publish a git bundle to GitHub main (fast-forward only, never forced).
rem Usage:  publish.bat "C:\Users\Reza\Downloads\market-radar-publish.bundle"
rem Run it from the repository folder (the folder that contains .git).

if "%~1"=="" goto :usage
if not exist "%~1" (
  echo File not found: %~1
  exit /b 1
)
if not exist ".git" (
  echo This script must be run from the repository folder.
  exit /b 1
)

echo [1/2] Reading main from the bundle...
git fetch "%~1" main
if errorlevel 1 (
  echo Fetch failed. Send this whole output to the assistant.
  exit /b 1
)

echo [2/2] Pushing to GitHub main (fast-forward only)...
git push origin FETCH_HEAD:refs/heads/main
if errorlevel 1 (
  echo Push was rejected. Send this whole output to the assistant.
  exit /b 1
)

echo.
echo Pushed. The deploy runs now:
echo https://github.com/rfanisani/financial-market-intelligence-website/actions
echo When it is green, open https://fanisani.ir/en/ and press Ctrl+F5.
exit /b 0

:usage
echo Usage: publish.bat "path\to\market-radar-publish.bundle"
exit /b 1
