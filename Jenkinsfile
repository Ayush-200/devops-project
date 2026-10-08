// Jenkins pipeline for the DevOps demo.
//
// Required Jenkins plugins:
//   - Docker Pipeline      (docker build/push steps)
//   - Kubernetes CLI       (kubectl)
//
// Credentials (only needed when PUSH/DEPLOY are enabled):
//   - id: dockerhub  -> Username with password (registry login)
//   - id: kubeconfig -> Secret file (kubeconfig for the target cluster)
//
// A local Jenkins that can build images needs the Docker socket mounted:
//   docker run -d --name jenkins -p 8080:8080 -p 50000:50000 \
//     -v /var/run/docker.sock:/var/run/docker.sock \
//     -v jenkins_home:/var/jenkins_home jenkins/jenkins:lts
pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 20, unit: 'MINUTES')
    }

    tools {
        nodejs 'node-20'
    }

    environment {
        APP_DIR       = 'app'
        IMAGE_NAME    = "${params.REGISTRY}/${params.REPO_IMAGE}"
        IMAGE_TAG     = "${env.BUILD_NUMBER}"
        REGISTRY_CRED = 'dockerhub'
        KUBECONFIG_CRED = 'kubeconfig'
    }

    parameters {
        string(name: 'REGISTRY',      defaultValue: 'docker.io',                description: 'Container registry host')
        string(name: 'REPO_IMAGE',    defaultValue: 'ayush/devops-demo-app',    description: 'Repository/image name')
        string(name: 'PUSH',          defaultValue: 'false',                   description: 'Push the image to the registry (needs the dockerhub credential)')
        string(name: 'DEPLOY',        defaultValue: 'true',                    description: 'Deploy to Kubernetes after a green build (needs the kubeconfig credential)')
        string(name: 'K8S_MANIFESTS', defaultValue: 'k8s',                     description: 'Directory holding the Kubernetes manifests')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install dependencies') {
            steps {
                dir(APP_DIR) {
                    sh 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund'
                }
            }
        }

        stage('Test') {
            steps {
                dir(APP_DIR) {
                    sh 'npm test'
                }
            }
        }

        stage('Build image') {
            steps {
                sh 'docker build -t "$IMAGE_NAME:$IMAGE_TAG" -t "$IMAGE_NAME:latest" "$APP_DIR"'
            }
        }

        stage('Scan image') {
            when {
                expression {
                    sh(script: 'command -v trivy >/dev/null 2>&1 && echo yes || echo no', returnStdout: true).trim() == 'yes'
                }
            }
            steps {
                sh 'trivy image --severity HIGH,CRITICAL --exit-code 0 "$IMAGE_NAME:$IMAGE_TAG"'
            }
        }

        stage('Push image') {
            when {
                expression { params.PUSH == 'true' }
            }
            steps {
                withCredentials([usernamePassword(credentialsId: env.REGISTRY_CRED, usernameVariable: 'USER', passwordVariable: 'PASS')]) {
                    sh '''
                        echo "$PASS" | docker login "$REGISTRY" -u "$USER" --password-stdin
                        docker push "$IMAGE_NAME:$IMAGE_TAG"
                        docker push "$IMAGE_NAME:latest"
                    '''
                }
            }
        }

        stage('Deploy to Kubernetes') {
            when {
                expression { params.DEPLOY == 'true' }
            }
            steps {
                withCredentials([file(credentialsId: env.KUBECONFIG_CRED, variable: 'KUBECONFIG')]) {
                    sh '''
                        kubectl apply -f "$K8S_MANIFESTS"
                        kubectl -n demo set image deployment/devops-demo-app app="$IMAGE_NAME:$IMAGE_TAG"
                        kubectl -n demo rollout status deployment/devops-demo-app --timeout=120s
                    '''
                }
            }
        }
    }

    post {
        success { echo "Build #${env.BUILD_NUMBER} succeeded -> ${env.IMAGE_NAME}:${env.IMAGE_TAG}" }
        failure { echo "Build #${env.BUILD_NUMBER} failed - check the stage log above." }
    }
}
