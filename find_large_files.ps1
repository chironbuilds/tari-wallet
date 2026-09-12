Get-ChildItem -Path "C:\Users\harsh" -Recurse -File -ErrorAction SilentlyContinue | 
    Sort-Object Length -Descending | 
    Select-Object -First 100 FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,1)}} | 
    Format-Table -AutoSize
