#define MyAppName "Koolezt Creative Factory Render Worker"
#define MyAppVersion "1.2.4"
#define MyAppExeName "CreativeFactoryRenderWorker.exe"

[Setup]
AppId={{581D15DD-C2F6-48B5-A414-5BD3E09FD3CB}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Koolezt
DefaultDirName={localappdata}\Programs\KooleztCreativeFactoryRenderWorker
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=KooleztCreativeFactoryRenderWorker-1.2.4-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=yes

[Files]
Source: "..\dist\render-worker\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\render-worker\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\render-worker\ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\render-worker\launch-worker.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Tasks]
Name: "autostart"; Description: "Start Render Worker automatically with Windows"; GroupDescription: "Windows startup:"; Flags: checkedonce

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "KooleztCreativeFactoryRenderWorker"; ValueData: """{sys}\wscript.exe"" ""{app}\launch-worker.vbs"""; Flags: uninsdeletevalue; Tasks: autostart
Root: HKCU; Subkey: "Software\Classes\koolezt-creative-worker"; ValueType: string; ValueData: "URL:Koolezt Creative Factory Render Worker"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\koolezt-creative-worker"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\koolezt-creative-worker\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""--reconnect"""

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-worker.vbs"""; Description: "Start Koolezt Creative Factory Render Worker"; Flags: postinstall nowait skipifsilent

[Code]
var
  ConnectPage: TInputQueryWizardPage;

function SetEnvironmentVariable(lpName, lpValue: string): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function CredentialExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\KooleztCreativeFactoryRenderWorker\worker-token.dpapi')) and
            FileExists(ExpandConstant('{localappdata}\KooleztCreativeFactoryRenderWorker\config.json'));
end;

procedure InitializeWizard;
begin
  ConnectPage := CreateInputQueryPage(wpSelectTasks,
    'Connect this computer to Koolezt Creative Factory',
    'Enter the short Setup Code supplied by the owner.',
    'The code is used once and the permanent credential is protected for this Windows user.');
  ConnectPage.Add('Setup Code:', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ConnectPage.ID) and CredentialExists();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ConnectPage.ID) and (Trim(ConnectPage.Values[0]) = '') then
  begin
    MsgBox('Enter the Setup Code supplied by the owner.', mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and (not CredentialExists()) then
  begin
    SetEnvironmentVariable('KOOLEZT_WORKER_SETUP_CODE', Trim(ConnectPage.Values[0]));
    try
      if not Exec(ExpandConstant('{app}\{#MyAppExeName}'),
        'enroll --server https://worker.printwlove.com',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
        RaiseException('Connection failed. Ask the owner for a new Setup Code and run the installer again.');
    finally
      SetEnvironmentVariable('KOOLEZT_WORKER_SETUP_CODE', '');
    end;
    MsgBox('Connected successfully.', mbInformation, MB_OK);
  end;
end;