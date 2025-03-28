import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const exec = promisify(cp.exec);

export function activate(context: vscode.ExtensionContext) {
  // Register the sidebar webview provider
  const provider = new AndroidEmulatorViewProvider(context.extensionUri);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('androidEmulatorView', provider)
  );

  // Command for opening the sidebar
  let disposable = vscode.commands.registerCommand('vscode-android-emulator-sidepanel.openEmulator', () => {
    vscode.commands.executeCommand('workbench.view.extension.android-emulator');
  });

  context.subscriptions.push(disposable);
}

interface AvdInfo {
  name: string;
  status: 'stopped' | 'running';
}

class AndroidEmulatorViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getWebviewContent();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'getAvds':
          const avds = await this._getAvailableAvds();
          webviewView.webview.postMessage({ command: 'avdList', avds });
          break;
        case 'launchAvd':
          this._launchAvd(message.avdName);
          break;
        case 'refresh':
          const refreshedAvds = await this._getAvailableAvds();
          webviewView.webview.postMessage({ command: 'avdList', avds: refreshedAvds });
          break;
      }
    });
  }

  private async _getAvailableAvds(): Promise<AvdInfo[]> {
    try {
      // Get list of AVDs
      const { stdout } = await exec('emulator -list-avd');
      
      if (!stdout) {
        return [];
      }

      // Split output by newlines and filter empty lines
      const avds = stdout.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(name => ({ name, status: 'stopped' as 'stopped' | 'running' }));

      // Check running emulators
      try {
        const { stdout: runningOutput } = await exec('adb devices');
        const runningLines = runningOutput.split('\n');
        
        // Mark AVDs as running if they appear in adb devices output
        for (const avd of avds) {
          if (runningLines.some(line => line.includes('emulator') && line.includes('device'))) {
            avd.status = 'running';
          }
        }
      } catch (e) {
        // Ignore errors checking running state
      }

      return avds;
    } catch (error) {
      vscode.window.showErrorMessage('Failed to list Android AVDs. Make sure Android SDK is installed and in your PATH.');
      return [];
    }
  }

  private async _launchAvd(avdName: string) {
    try {
      const platform = os.platform();
      let command = '';

      if (platform === 'win32') {
        // Windows
        command = `start cmd.exe /c "emulator -avd ${avdName}"`;
      } else if (platform === 'darwin') {
        // macOS
        command = `osascript -e 'tell application "Terminal" to do script "emulator -avd ${avdName}"'`;
      } else {
        // Linux
        command = `x-terminal-emulator -e "emulator -avd ${avdName}"`;
      }

      cp.exec(command, (error) => {
        if (error) {
          vscode.window.showErrorMessage(`Failed to launch AVD: ${error.message}`);
        } else {
          vscode.window.showInformationMessage(`Launching Android emulator: ${avdName}`);
        }
      });
    } catch (error) {
      vscode.window.showErrorMessage('Failed to launch Android emulator.');
    }
  }

  private _getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Android Emulator</title>
        <style>
          body { padding: 0; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
          .container { padding: 10px; }
          .avd-item { 
            padding: 8px;
            margin: 4px 0;
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .avd-item .name {
            flex-grow: 1;
            margin-right: 8px;
          }
          .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 12px;
            border-radius: 2px;
            cursor: pointer;
          }
          .button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }
          .refresh-btn {
            margin-bottom: 10px;
          }
          .status-running {
            color: #4caf50;
            font-size: 0.8em;
          }
          .status-stopped {
            color: #9e9e9e;
            font-size: 0.8em;
          }
          .loading {
            font-style: italic;
            color: var(--vscode-descriptionForeground);
          }
        </style>
    </head>
    <body>
        <div class="container">
            <h3>Android Emulator</h3>
            <button class="button refresh-btn" id="refresh-btn">Refresh AVD List</button>
            <p id="loading-text" class="loading">Loading available AVDs...</p>
            <div id="avd-list"></div>
        </div>
        <script>
            (function() {
                const vscode = acquireVsCodeApi();
                const avdListContainer = document.getElementById('avd-list');
                const loadingText = document.getElementById('loading-text');
                const refreshBtn = document.getElementById('refresh-btn');
                
                // Request AVD list on load
                vscode.postMessage({ command: 'getAvds' });
                
                // Handle refresh button
                refreshBtn.addEventListener('click', () => {
                    loadingText.style.display = 'block';
                    avdListContainer.innerHTML = '';
                    vscode.postMessage({ command: 'refresh' });
                });
                
                // Listen for messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    switch (message.command) {
                        case 'avdList':
                            loadingText.style.display = 'none';
                            renderAvdList(message.avds);
                            break;
                    }
                });
                
                function renderAvdList(avds) {
                    avdListContainer.innerHTML = '';
                    
                    if (avds.length === 0) {
                        avdListContainer.innerHTML = '<p>No AVDs found. Create one in Android Studio.</p>';
                        return;
                    }
                    
                    avds.forEach(avd => {
                        const avdItem = document.createElement('div');
                        avdItem.className = 'avd-item';
                        
                        const nameContainer = document.createElement('div');
                        nameContainer.className = 'name';
                        
                        const nameEl = document.createElement('div');
                        nameEl.textContent = avd.name;
                        
                        const statusEl = document.createElement('div');
                        statusEl.className = avd.status === 'running' ? 'status-running' : 'status-stopped';
                        statusEl.textContent = avd.status === 'running' ? '● Running' : '○ Stopped';
                        
                        nameContainer.appendChild(nameEl);
                        nameContainer.appendChild(statusEl);
                        avdItem.appendChild(nameContainer);
                        
                        const launchBtn = document.createElement('button');
                        launchBtn.className = 'button';
                        launchBtn.textContent = avd.status === 'running' ? 'Already Running' : 'Launch';
                        launchBtn.disabled = avd.status === 'running';
                        
                        if (avd.status !== 'running') {
                            launchBtn.addEventListener('click', () => {
                                vscode.postMessage({
                                    command: 'launchAvd',
                                    avdName: avd.name
                                });
                                launchBtn.textContent = 'Launching...';
                                launchBtn.disabled = true;
                                
                                // Give it some time and then refresh list
                                setTimeout(() => {
                                    vscode.postMessage({ command: 'refresh' });
                                }, 5000);
                            });
                        }
                        
                        avdItem.appendChild(launchBtn);
                        avdListContainer.appendChild(avdItem);
                    });
                }
            })();
        </script>
    </body>
    </html>`;
  }
}