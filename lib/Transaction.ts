import 'reflect-metadata';
import { EntityManager, Repository } from 'typeorm';

import { Controller } from '@nestjs/common/interfaces';

const transactionRepositoryKey = 'transaction_repository';

interface ServiceWithRepository {
  [transactionRepositoryKey]: Repository<any>;
  repositoryKey: string;
}

interface ServiceDescriptor {
  key: string;
  value: ServiceWithRepository;
}

/**
 * To be Injectable is cool, but having a repository is > 9000
 */
function isInjectableService(target: any): boolean {
  const metadataKey = 'design:paramtypes';
  return (
    !!Reflect.getOwnMetadata(metadataKey, target.constructor) &&
    !!Object.values(target).find((value) => value instanceof Repository)
  );
}

function cloneRepository(repository: any) {
  const newRepository = new repository.constructor(
    ...Object.values(repository),
  );
  Object.defineProperties(
    newRepository,
    Object.getOwnPropertyDescriptors(repository),
  );

  return newRepository;
}

function cloneRecursivelyService(
  service: any,
  originalTarget: any,
  register: Record<string, any> = {},
) {
  if (register.hasOwnProperty(service.constructor.name)) {
    return register;
  }

  /**
   * Proxy since we need mutual inclusive values at runtime
   */
  const cloneService = new (service.constructor as any)();
  const proxyAccess: ProxyHandler<any> = {};
  const proxyService = new Proxy(cloneService, proxyAccess);

  // Register before recursion
  register[service.constructor.name] = proxyService;

  const property = Object.entries(service).reduce((acc, [key, value]) => {
    if (register[value.constructor.name]) {
      return { ...acc, [key]: register[value.constructor.name] };
    }

    if (isInjectableService(value)) {
      return {
        ...acc,
        [key]: cloneRecursivelyService(value, originalTarget, register),
      };
    }

    return { ...acc, [key]: value };
  }, {});

  // Define properties post recursion, proxy should be fine with it
  Object.defineProperties(
    cloneService,
    Object.getOwnPropertyDescriptors(property),
  );

  const [repositoryKey, repository] = Object.entries(cloneService).find(
    ([, entity]) => {
      return entity instanceof Repository;
    },
  ) || [null];

  if (repositoryKey) {
    Object.defineProperty(cloneService, 'repositoryKey', {
      value: repositoryKey,
      enumerable: true,
    });

    const newRepository = cloneRepository(repository);

    Object.defineProperty(cloneService, transactionRepositoryKey, {
      value: newRepository,
      enumerable: true,
    });
  }

  return proxyService;
}

function cloneController(originalTarget: any): Controller {
  const property = Object.entries(originalTarget).reduce(
    (acc, [key, value]) => {
      if (isInjectableService(value)) {
        return {
          ...acc,
          [key]: cloneRecursivelyService(value, originalTarget, {}),
        };
      }
      return { ...acc, [key]: value };
    },
    {},
  );

  const target = new (originalTarget.constructor as any)(
    ...Object.values(property),
  );

  return target;
}

function patchRepository(
  serviceDescriptor: ServiceDescriptor,
  transactionalManager: EntityManager,
): void {
  const protoRepo = Object.getPrototypeOf(
    serviceDescriptor.value[serviceDescriptor.value.repositoryKey],
  );

  Object.keys(protoRepo)
    .filter((key) => {
      return !['query'].includes(key);
    })
    .forEach((key: string) => {
      serviceDescriptor.value[transactionRepositoryKey][key] =
        transactionalManager[key].bind(
          transactionalManager,
          serviceDescriptor.value[transactionRepositoryKey].target,
        );
    });

  Object.defineProperty(
    serviceDescriptor.value,
    serviceDescriptor.value.repositoryKey,
    {
      value: serviceDescriptor.value[transactionRepositoryKey],
    },
  );
}

function getServicesWithRepository(
  target: any,
  register: any = [],
): ServiceDescriptor[] {
  // Since every service has been proxied, there should be only one of each type
  register.push(target.constructor.name);

  return Object.entries(target).reduce((acc, [key, value]) => {
    if (
      isInjectableService(value) &&
      !register.includes(value.constructor.name)
    ) {
      const [repositoryKey] = Object.entries(value).find(([, entity]) => {
        return entity instanceof Repository;
      }) || [null];

      const children = getServicesWithRepository(value, register);

      if (repositoryKey) {
        return [...acc, { key, value }, ...children];
      }

      return [...acc, ...children];
    }

    return acc;
  }, []);
}

async function wrapInTransaction(
  originalTarget: any,
  args: any,
  method: any,
  propertyKey: string,
) {
  // I hope garbage collection will get rid of clones
  const target = cloneController(originalTarget);
  const services = getServicesWithRepository(target);

  const mainRepository = services?.[0]?.value?.[transactionRepositoryKey];

  const value = await (mainRepository
    ? mainRepository.manager.transaction(
        async (transactionManager: EntityManager) => {
          services.forEach((service) => {
            patchRepository(service, transactionManager);
          });

          return await method.apply(target, args);
        },
      )
    : method.apply(originalTarget, args));

  return value;
}

export function Transaction() {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const method = descriptor.value;
    descriptor.value = async function (...args) {
      return await wrapInTransaction(this, args, method, propertyKey);
    };
  };
}
