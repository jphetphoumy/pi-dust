{
  description = "Dev environment for pi-agent dust extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.just
          ];

          shellHook = ''
            echo "Node $(node --version) | npm $(npm --version)"
            if [ ! -d node_modules ]; then
              echo "Installing dependencies..."
              npm install
            fi
          '';
        };
      });
}
