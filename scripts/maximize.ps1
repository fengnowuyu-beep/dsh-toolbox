<#
    dsh-toolbox - maximize the Desktop window.

    The plugin cannot ask the shell to maximize its window: Electron's main
    process owns it, and the plugin surfaces reach neither that process nor its
    `BrowserWindow` (a page cannot resize a window it did not open). So the window
    is driven through the OS - see appwindow.ps1, which holds the shared window
    code - and the result is the same operation the user's own title-bar
    double-click performs.

    The wait loop matters: the Host starts before the application shows its window,
    and forcing a hidden window visible would flash a blank frame ahead of the
    shell's own timing. Only a window that is already visible is maximized.

    Pure ASCII by construction: Windows PowerShell 5.1 reads a script without a
    byte-order mark as ANSI, so a non-ASCII literal here would be misread.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$TimeoutSeconds = 20,
    [string]$LogFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'appwindow.ps1')

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
while ((Get-Date) -lt $deadline) {
    $window = Get-AppWindowHandle -ProcessId $ProcessId -RequireVisible
    if ($window -ne [System.IntPtr]::Zero) {
        [void](Set-AppWindowMaximized -Handle $window)
        Write-AppWindowLog $LogFile ("maximized window 0x{0:X} of pid {1}" -f [int64]$window, $ProcessId)
        exit 0
    }
    Start-Sleep -Milliseconds 300
}

Write-AppWindowLog $LogFile ("no visible window for pid {0} within {1}s" -f $ProcessId, $TimeoutSeconds)
exit 1
