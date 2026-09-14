' Hides the console window when the scheduled task runs at logon.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """F:\Development\pi-web\scripts\autostart-pi-web.cmd""", 0, False
