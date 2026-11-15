<#
    dsh-toolbox - window control shared by the tray companion and the maximize
    helper.

    The shell owns its window and offers a plugin no surface for it: a page cannot
    resize a window it did not open, and the preload exposes no window geometry.
    So the window is driven through the OS instead - exactly what the user's own
    title-bar double-click does.

    This file defines functions only and must stay side-effect free so it can be
    dot-sourced by a long-lived process (the tray companion) and by a one-shot
    helper (maximize.ps1) alike. It is ASCII-only by construction: Windows
    PowerShell 5.1 reads a BOM-less script as the system ANSI code page, so a
    non-ASCII literal here would be misread.
#>

if (-not ('DshToolboxWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshToolboxWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public delegate bool EnumWindowsProc(IntPtr window, IntPtr extra);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
}

# ShowWindow commands, named so the call sites read as what they do.
$script:SW_HIDE = 0
$script:SW_SHOW = 5
$script:SW_RESTORE = 9
$script:SW_MAXIMIZE = 3

$script:GWL_EXSTYLE = -20
$script:WS_EX_TOOLWINDOW = 0x00000080

<#
    The application's own top-level window.
    @returns the window handle, or [IntPtr]::Zero when the process has none yet.
#>
function Get-AppWindowHandle {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        # When set, a window that is currently hidden is not acceptable: callers
        # that must not pre-empt the shell's own show timing use this.
        [switch]$RequireVisible
    )

    $script:bestWindow = [System.IntPtr]::Zero
    $script:bestScore = -1
    $callback = [DshToolboxWindow+EnumWindowsProc] {
        param([System.IntPtr]$window, [System.IntPtr]$extra)
        $owner = [uint32]0
        [void][DshToolboxWindow]::GetWindowThreadProcessId($window, [ref]$owner)
        if ($owner -ne [uint32]$ProcessId) { return $true }

        $style = [DshToolboxWindow]::GetWindowLong($window, $script:GWL_EXSTYLE)
        if (($style -band $script:WS_EX_TOOLWINDOW) -ne 0) { return $true }

        $visible = [DshToolboxWindow]::IsWindowVisible($window)
        if ($RequireVisible -and -not $visible) { return $true }

        $rect = New-Object DshToolboxWindow+RECT
        [void][DshToolboxWindow]::GetWindowRect($window, [ref]$rect)
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -lt 200 -or $height -lt 150) { return $true }

        # The biggest titled window is the application, ahead of any popup; a
        # visible one always beats a hidden one, so a hidden helper window can
        # never be mistaken for the real window while it is on screen.
        $score = ([int64]$width * $height) + ([int64][DshToolboxWindow]::GetWindowTextLength($window) * 1000)
        if ($visible) { $score += 1000000000000 }
        if ($score -gt $script:bestScore) {
            $script:bestScore = $score
            $script:bestWindow = $window
        }
        return $true
    }
    [void][DshToolboxWindow]::EnumWindows($callback, [System.IntPtr]::Zero)
    return $script:bestWindow
}

<# @returns `{ Visible, Iconic, Maximized }` for one window handle. #>
function Get-AppWindowState {
    param([Parameter(Mandatory = $true)][System.IntPtr]$Handle)
    if ($Handle -eq [System.IntPtr]::Zero) {
        return @{ Visible = $false; Iconic = $false; Maximized = $false }
    }
    return @{
        Visible = [DshToolboxWindow]::IsWindowVisible($Handle)
        Iconic = [DshToolboxWindow]::IsIconic($Handle)
        Maximized = [DshToolboxWindow]::IsZoomed($Handle)
    }
}

<#
    Bring one window to the front. Windows refuses a foreground switch unless the
    caller owns the foreground, and a click on the caller's own window is what
    grants that - which is why the tray does this in its own process rather than
    asking the Host to do it.
    @returns whether the window ended up in front.
#>
function Set-AppWindowForeground {
    param([Parameter(Mandatory = $true)][System.IntPtr]$Handle)
    if ($Handle -eq [System.IntPtr]::Zero) { return $false }
    [void][DshToolboxWindow]::BringWindowToTop($Handle)
    if ([DshToolboxWindow]::SetForegroundWindow($Handle)) { return $true }
    $target = [uint32]0
    [void][DshToolboxWindow]::GetWindowThreadProcessId($Handle, [ref]$target)
    $current = [DshToolboxWindow]::GetCurrentThreadId()
    $attached = [DshToolboxWindow]::AttachThreadInput($current, $target, $true)
    try {
        return [DshToolboxWindow]::SetForegroundWindow($Handle)
    } finally {
        if ($attached) { [void][DshToolboxWindow]::AttachThreadInput($current, $target, $false) }
    }
}

<# Maximize one window (the same operation as double-clicking its title bar). #>
function Set-AppWindowMaximized {
    param([Parameter(Mandatory = $true)][System.IntPtr]$Handle)
    if ($Handle -eq [System.IntPtr]::Zero) { return $false }
    [void][DshToolboxWindow]::ShowWindowAsync($Handle, $script:SW_MAXIMIZE)
    [void](Set-AppWindowForeground $Handle)
    return $true
}

<#
    Show or hide one window.
    SW_SHOW is used rather than SW_RESTORE when the window was hidden: restore
    would drop a maximized window back to its normal size, while show keeps the
    size and placement it was hidden with.
    @returns `'shown'`, `'hidden'` or `'none'`.
#>
function Set-AppWindowShown {
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [Parameter(Mandatory = $true)][bool]$Show
    )
    if ($Handle -eq [System.IntPtr]::Zero) { return 'none' }
    if (-not $Show) {
        [void][DshToolboxWindow]::ShowWindowAsync($Handle, $script:SW_HIDE)
        return 'hidden'
    }
    $state = Get-AppWindowState $Handle
    $command = if ($state.Iconic) { $script:SW_RESTORE } else { $script:SW_SHOW }
    [void][DshToolboxWindow]::ShowWindowAsync($Handle, $command)
    [void](Set-AppWindowForeground $Handle)
    return 'shown'
}

<#
    Show the window if it is hidden or minimized, hide it if it is on screen.
    @returns `'shown'`, `'hidden'` or `'none'`.
#>
function Invoke-AppWindowToggle {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $handle = Get-AppWindowHandle -ProcessId $ProcessId
    if ($handle -eq [System.IntPtr]::Zero) { return 'none' }
    $state = Get-AppWindowState $handle
    # A window that is minimized is "visible" to Windows but not to the user, so
    # a toggle there means "bring it back", not "hide it for good".
    $onScreen = $state.Visible -and (-not $state.Iconic)
    if ($onScreen) { return Set-AppWindowShown -Handle $handle -Show $false }
    return Set-AppWindowShown -Handle $handle -Show $true
}

<# Append one line to a best-effort log; never throws. #>
function Write-AppWindowLog {
    param([string]$LogFile, [string]$Message)
    if ([string]::IsNullOrWhiteSpace($LogFile)) { return }
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Add-Content -LiteralPath $LogFile -Value ("{0} [window] {1}" -f $stamp, $Message) -Encoding UTF8
    } catch {
        # Logging must never break the action it describes.
    }
}
