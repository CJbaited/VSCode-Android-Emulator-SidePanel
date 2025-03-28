import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
  // Register the sidebar webview provider
  const provider = new AndroidEmulatorViewProvider(context.extensionUri);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('androidEmulatorView', provider)
  );

  // Keep the command for backwards compatibility, now it just focuses the sidebar
  let disposable = vscode.commands.registerCommand('VSCode-Android-Emulator-SidePanel.openEmulator', () => {
    vscode.commands.executeCommand('workbench.view.extension.android-emulator');
  });

  context.subscriptions.push(disposable);
}

class AndroidEmulatorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getWebviewContent();

    // TODO: Handle messages from the webview
  }

  private _getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Android Emulator</title>
        <style>
          body { padding: 0; margin: 0; }
          .container { padding: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h3>Android Emulator</h3>
            <p>Loading available AVDs...</p>
            <div id="avd-list"></div>
        </div>
        <script>
            // Will add interactive functionality here later
        </script>
    </body>
    </html>`;
  }
}