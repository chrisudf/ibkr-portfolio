# 本地启动：加载 scripts/sync.env 里的变量后运行 Flask
# 用法：在仓库根目录执行  .\scripts\run-local.ps1
$root = Split-Path $PSScriptRoot -Parent
Get-Content (Join-Path $PSScriptRoot 'sync.env') | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $name, $value = $_ -split '=', 2
    Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim('"')
}
& (Join-Path $root '.venv\Scripts\python.exe') (Join-Path $root 'app.py')
