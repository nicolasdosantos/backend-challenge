import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * Ponto de extensão para autenticação dos provedores (decisão em ARCHITECTURE.md).
 * Autenticação não foi implementada: o guard libera tudo. O desenho previsto é validar
 * um JWT emitido por um IdP externo (ex.: Keycloak) e conferir que o `providerId` do
 * token é o mesmo do payload. Será aplicado aos controllers de negócio, nunca ao health.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
